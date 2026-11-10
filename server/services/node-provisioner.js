'use strict';
const fs = require('node:fs');
const { buildRemoteConfigPy } = require('../../lib/remote-config');
module.exports = function createNodeProvisioner({ cfg, runCmd, ensureNodeLocalDirAndSymlink, MCP_TOKEN }) {
function getSyncthingApiKey() {
  try {
    const cfgXml = fs.readFileSync(
      cfg.findSyncthingConfig(),
      'utf8'
    );
    const m = cfgXml.match(/<apikey>([^<]+)<\/apikey>/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// Automatically provision a Linux node:
// 1. Ensure local workN folder + Syncthing folder registration on Mac
// 2. Establish isolated Reverse SSH Tunnel (-R 18765 & -R 49620) to the Linux host
// 3. Configure remote ~/.claude.json to point `mac-industrial-mcp` to http://127.0.0.1:18765/mcp?node=<nodeId>
// 4. Auto-pair Syncthing device & folder if Syncthing is installed on the remote Linux host
async function provisionLinuxNode(node) {
  ensureNodeLocalDirAndSymlink(node);
  const logs = [`本地目录已就绪: ${node.localWorkDir}`];

  // Register local folder in Mac Syncthing if API key available
  const stKey = getSyncthingApiKey();
  let macDeviceId = '';
  if (stKey && node.syncthingFolderId) {
    try {
      const sysRes = await runCmd('curl', ['-s', '--max-time', '2', '-H', `X-API-Key: ${stKey}`, `${cfg.SYNCTHING_URL}/rest/system/status`], 2500);
      if (sysRes.stdout) {
        macDeviceId = JSON.parse(sysRes.stdout).myID || '';
      }
      const folderPayload = {
        id: node.syncthingFolderId,
        label: `TAKT ${node.localWorkAlias} (${node.name})`,
        filesystemType: 'basic',
        path: node.localWorkDir,
        type: 'sendreceive',
        fsWatcherEnabled: true,
        fsWatcherDelayS: 1,
        rescanIntervalS: 60,
      };
      if (node.syncthingDeviceId) {
        folderPayload.devices = macDeviceId
          ? [{ deviceID: macDeviceId }, { deviceID: node.syncthingDeviceId }]
          : [{ deviceID: node.syncthingDeviceId }];
      }
      await runCmd('curl', [
        '-s', '-X', 'PUT',
        '-H', `X-API-Key: ${stKey}`,
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify(folderPayload),
        `${cfg.SYNCTHING_URL}/rest/config/folders/${encodeURIComponent(node.syncthingFolderId)}`,
      ], 3000);
      logs.push(`Mac Syncthing 同步目录已注册 (${node.syncthingFolderId})`);
    } catch {}
  }

  if (!node.sshHost) {
    return { ok: true, logs };
  }

  // Tunnel lifecycle belongs to the MCP watchdog; never race a second manager.
  // Provision remote work directory + ~/.claude.json MCP entry + read remote Syncthing Device ID
  const setupPy = buildRemoteConfigPy({ node, port: cfg.MCP_PORT, token: MCP_TOKEN, autoAllowHostExec: cfg.AUTO_ALLOW_HOST_EXEC });
  const remRes = await runCmd('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ClearAllForwardings=yes',
    node.sshHost, 'python3 -',
  ], 8000, { input: setupPy });
  if (remRes.exitCode !== 0) {
    logs.push('远端 MCP 配置失败，请检查 SSH、Python 与已有 JSON 配置');
    return { ok: false, logs };
  }

  if (remRes.exitCode === 0 && remRes.stdout.trim()) {
    try {
      const info = JSON.parse(remRes.stdout.trim().split('\n').pop());
      if (info.workDir && info.workDir !== node.remoteWorkDir) {
        node.remoteWorkDir = info.workDir;
      }
      logs.push(`远端目录 ${info.workDir} 与 Mac MCP 桥接已自动注入 ~/.claude.json`);
      if (info.syncthingDeviceId && !node.syncthingDeviceId) {
        node.syncthingDeviceId = info.syncthingDeviceId;
        logs.push(`检测到远端 Syncthing Device ID: ${info.syncthingDeviceId.slice(0, 15)}...`);
      }
    } catch {}
  }

  logs.push('MCP 隧道由本地守护服务建立，连接状态请查看状态栏');
  return { ok: true, logs };
}

return provisionLinuxNode;
};
