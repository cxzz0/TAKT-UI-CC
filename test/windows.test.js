'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { mapper } = require('../lib/workspace-paths');
const { createRequestContext } = require('../mcp-server/request-context');
const { TunnelManager } = require('../lib/ssh-tunnels');
const { tunnelArgs } = require('../lib/tunnel-config');
const platform = require('../lib/platform');

test('Windows drive paths, UNC, Unicode, line numbers and explicit node selection', () => {
  const nodes = [
    { id: 'a', localWorkDir: 'C:\\用户\\work', remoteWorkDir: '/srv/a' },
    { id: 'b', localWorkDir: '\\\\server\\share\\work', remoteWorkDir: '/srv/b' },
  ];
  const maps = mapper(nodes, nodes[0].localWorkDir, '', path.win32);
  assert.equal(maps.resolve('/srv/a/中文 file.txt:12', '/srv/a', 'a').localPath, 'C:\\用户\\work\\中文 file.txt');
  assert.equal(maps.resolve('c:\\用户\\work\\code.js', '/srv/a', 'a').remotePath, '/srv/a/code.js');
  assert.equal(maps.resolve('code.js', '/srv/b/sub', 'b').localPath, '\\\\server\\share\\work\\sub\\code.js');
  assert.equal(maps.resolve('outside.txt', '/opt/project', 'a').localPath, '');
  assert.equal(maps.resolve('outside.txt', '/opt/project', 'a').remotePath, '/opt/project/outside.txt');
  assert.equal(maps.resolve(nodes[1].localWorkDir, '/srv/a', 'a').node.id, 'a');
  assert.throws(() => maps.resolve('/root/work/x', '/root/work', 'missing'), /Unknown node/);
  const context = createRequestContext({ loadNodes: () => nodes, defaultWorkDir: nodes[0].localWorkDir, pathImpl: path.win32 });
  context.run('b', () => assert.equal(context.resolveWorkPath('/root/work/x'), '\\\\server\\share\\work\\x'));
  context.run('a', () => assert.equal(context.rewriteScriptPaths("'/srv/a/new/test.py'"), "'C:/用户/work/new/test.py'"));
});

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null });
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
  return child;
}
test('Windows tunnel waits for forward acknowledgement, owns one child and handles collisions', async () => {
  const cfg = { MCP_PORT: 18765, EDA_PORT: 49620, ENABLE_EDA_TUNNEL: false };
  const node = { id: 'a', sshHost: 'host', enabled: true, desktopWebPort: 16080, syncthingTunnelPort: 12200 };
  const children = [], calls = [];
  const manager = new TunnelManager(cfg, (_cmd, args) => {
    calls.push(args); const child = fakeChild(); children.push(child);
    setImmediate(() => child.stdout.write('TAKT_TUNNEL_READY\n')); return child;
  });
  await Promise.all([manager.ensure(node), manager.ensure(node)]);
  assert.equal(children.length, 1);
  assert.ok(manager.isRunning(node));
  assert.ok(calls[0].includes('127.0.0.1:18765:127.0.0.1:18765'));
  assert.ok(calls[0].includes('127.0.0.1:12200:127.0.0.1:22000'));
  assert.ok(calls[0].includes('127.0.0.1:16080:127.0.0.1:6080'));
  assert.ok(!calls[0].some(a => ['-S', '-M', '-Nf'].includes(a) || a.includes('49620')));
  await manager.reconcile([{ ...node, enabled: false }]);
  assert.equal(children[0].exitCode, 0); assert.equal(manager.tunnels.size, 0);
  const broken = new TunnelManager(cfg, () => {
    const child = fakeChild(); setImmediate(() => { child.exitCode = 255; child.emit('close', 255); }); return child;
  });
  await assert.rejects(broken.ensure(node), /remote port ownership/);
  await broken.stopAll();
  assert.ok(tunnelArgs({ ...cfg, ENABLE_EDA_TUNNEL: true }, node, true).includes('127.0.0.1:49620:127.0.0.1:49620'));
});

test('Windows watchdog preserves single-flight repair and bearer provisioning through stdin', async () => {
  const node = { id: 'a', sshHost: 'host', enabled: true, localWorkDir: 'C:\\work' };
  const calls = [], lifecycle = [];
  const watchdog = require('../mcp-server/watchdog')({ cfg: { MCP_PORT: 18765, EDA_PORT: 49620, TAKT_HOME: 'C:\\takt', SSH_SOCKET_DIR: 'C:\\sockets' },
    windows: true, TOOLS: [], MCP_TOKEN: 'test-secret', loadConfiguredNodes: () => [node],
    tunnelManager: { stop: async id => lifecycle.push('stop:' + id), ensure: async n => lifecycle.push('start:' + n.id), stopAll: async () => lifecycle.push('all') },
    runCommand: async (cmd, args, options) => { calls.push({ cmd, args, options }); return { exitCode: 0 }; },
  });
  await Promise.all([watchdog.healNodeTunnel(node), watchdog.healNodeTunnel(node)]);
  assert.deepEqual(lifecycle, ['stop:a', 'start:a']);
  assert.equal(calls.length, 1); assert.ok(calls[0].args.includes('python3 -'));
  assert.ok(calls[0].options.input.includes('Authorization'));
  assert.ok(!calls[0].args.some(a => ['-S', '-M', '-Nf'].includes(a) || a.includes('test-secret')));
  await watchdog.stop(); assert.equal(lifecycle.at(-1), 'all');
});

test('Windows env supports BOM, CRLF, quoted paths and literal values', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'env'), '\uFEFF# local config\r\nTAKT_HOME="C:\\用户\\my data"\r\nTAKT_PORT=31999\r\nTAKT_EXAMPLE=$literal\r\n');
  const env = { TAKT_HOME: dir }; require('../scripts/load-env').load(env);
  assert.equal(env.TAKT_HOME, 'C:\\用户\\my data'); assert.equal(env.TAKT_PORT, '31999'); assert.equal(env.TAKT_EXAMPLE, '$literal');
});

test('Windows token ACL only grants the current user', { skip: !platform.isWindows }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-acl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  require('../lib/mcp-token').getOrCreateToken(dir);
  const file = path.join(dir, 'mcp-token');
  const result = spawnSync(platform.powershell, platform.psArgs(`$acl = Get-Acl -LiteralPath ${platform.psQuote(file)}; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; if (!$acl.AreAccessRulesProtected) { throw 'Inherited ACL' }; foreach ($r in $acl.Access) { if ($r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unexpected principal' } }`), { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});

test('native PTY reads commands, resizes and exits without stopping the workbench', { timeout: 20000 }, async () => {
  const { spawnTerminal } = require('../lib/pty-session');
  const terminal = spawnTerminal(process.execPath, ['-e', "process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { if (data.includes('run')) { console.log('TAKT_' + 'NATIVE_OK'); process.exit(0); } });"],
    { name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env: platform.childEnv() });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { terminal.kill(); reject(new Error('PTY timeout: ' + output)); }, 15000);
      terminal.onData(data => { output += data; });
      terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error('PTY failed: ' + output)); });
      terminal.resize(100, 30); terminal.write('run\r');
    });
    assert.ok(output.includes('TAKT_NATIVE_OK'), output);
  } finally { terminal.kill(); }
});
