'use strict';
const platform = require('../lib/platform');

module.exports = function createRemoteDesktop({ runCommand, ensureNodeTunnel, healNodeTunnel, nodeTunnelSock, windows = platform.isWindows, openTarget = platform.openTarget }) {
  return async function remoteDesktop(node, action) {
    const webPort = Number(node.desktopWebPort || 16080);
    const vncPort = Number(node.desktopVncPort || 15901);
    const urls = { nodeId: node.id, sshHost: node.sshHost, webPort, vncPort,
      webUrl: `http://127.0.0.1:${webPort}/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=1000`,
      vncUrl: `vnc://:instabox@127.0.0.1:${vncPort}` };
    if (windows) await ensureNodeTunnel(node);
    if (action === 'open-native-vnc') {
      const opener = openTarget(urls.vncUrl);
      const result = await runCommand(opener.command, opener.args, { timeoutMs: 4000 });
      return { ...urls, ok: result.exitCode === 0 };
    }
    if (!windows && action === 'start') {
      const check = await runCommand('lsof', ['-nP', `-iTCP:${webPort}`, '-sTCP:LISTEN'], { timeoutMs: 2000 });
      if (check.exitCode !== 0 || !check.stdout.trim()) await healNodeTunnel(node, false);
    }
    let command = 'printf "start\\n1440x900\\ntakt-ui\\n" | /usr/local/bin/instabox-desktop';
    if (action === 'takeover' || action === 'handback') {
      command = `printf "${action}\\n1440x900\\ntakt-ui\\n" | /usr/local/bin/instabox-desktop`;
    } else if (action === 'open-browser') {
      command = 'DISPLAY=:1 nohup /usr/local/bin/chromium https://www.google.com >/dev/null 2>&1 </dev/null & printf "status\\n1440x900\\ntakt-ui\\n" | /usr/local/bin/instabox-desktop';
    }
    const options = windows ? ['-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'BatchMode=yes'] : ['-S', nodeTunnelSock(node)];
    const result = await runCommand('ssh', [...options, '-o', 'ConnectTimeout=4', node.sshHost, command], { timeoutMs: 6000 });
    return { ...urls, ok: result.exitCode === 0, controller: (result.stdout || '').includes('controller human') ? 'user' : 'agent' };
  };
};
