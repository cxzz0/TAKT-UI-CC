'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { getOrCreateToken } = require('../lib/mcp-token');
const { buildRemoteConfigPy } = require('../lib/remote-config');
const { nodeTunnelSock, tunnelArgs } = require('../lib/tunnel-config');
const { createRequestContext } = require('../mcp-server/request-context');
const { isLoopbackHost, isLocalOrigin, hasBearerToken } = require('../lib/http-security');
const createNodeRegistry = require('../lib/node-registry');

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function config(directory) {
  return { TAKT_HOME: directory, DEFAULT_WORK_DIR: path.join(directory, 'work'), NODES_FILE: path.join(directory, 'nodes.json'),
    PRIMARY_NODE_ID: 'node-1', WORKSPACE_LINK_DIR: '', SSH_SOCKET_DIR: path.join(directory, 'sockets'), MCP_PORT: 18990, EDA_PORT: 49890 };
}

test('concurrent first starts share one complete token and repair private permissions', async (t) => {
  const directory = temp(t);
  const program = 'console.log(require(process.argv[1]).getOrCreateToken(process.argv[2]))';
  const values = await Promise.all(Array.from({ length: 12 }, () => exec(process.execPath,
    ['-e', program, require.resolve('../lib/mcp-token'), directory])));
  assert.equal(new Set(values.map((v) => v.stdout.trim())).size, 1);
  const token = values[0].stdout.trim();
  assert.match(token, /^[a-f0-9]{48}$/);
  fs.chmodSync(path.join(directory, 'mcp-token'), 0o644);
  assert.equal(getOrCreateToken(directory), token);
  assert.equal(fs.statSync(path.join(directory, 'mcp-token')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(directory, 'mcp-token'), '');
  assert.throws(() => getOrCreateToken(directory), /Invalid MCP token/);
});

test('loopback, exact origin port and bearer-only authentication', () => {
  for (const host of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080']) assert.ok(isLoopbackHost(host));
  for (const host of ['evil.test', '127.0.0.1.evil.test:3080', 'user@localhost:3080', '']) assert.ok(!isLoopbackHost(host));
  assert.ok(isLocalOrigin('http://localhost:3080', 3080));
  assert.ok(!isLocalOrigin('http://localhost:9999', 3080));
  assert.ok(!isLocalOrigin('https://localhost:3080', 3080));
  assert.ok(hasBearerToken({ authorization: 'Bearer secret' }, 'secret'));
  assert.ok(!hasBearerToken({ 'x-takt-token': 'secret' }, 'secret'));
});

test('provisioning migrates old broad allow rules, transports auth, preserves unrelated settings, and is idempotent', (t) => {
  const directory = temp(t);
  fs.mkdirSync(path.join(directory, '.claude'));
  fs.writeFileSync(path.join(directory, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: {
    other: { type: 'stdio', command: 'other' }, 'mac-industrial': { type: 'stdio', command: '/usr/local/bin/mac-industrial-mcp-client' },
    'mac-industrial-mcp': { type: 'http', url: 'old' },
  } }));
  const settingsPath = path.join(directory, '.claude/settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'keep', permissions: {
    allow: ['Read', 'mcp__mac-industrial', 'mcp__mac-industrial__*', 'mcp__mac-industrial__mac_host_exec'],
    ask: ['Bash'], deny: ['mcp__mac-industrial__mac_host_exec'],
  } }));
  const run = (allow = false) => {
    const script = buildRemoteConfigPy({ node: { id: 'node-two', remoteWorkDir: path.join(directory, 'work') }, port: 19001, token: 'test-secret', autoAllowHostExec: allow });
    // Mock only the remote home lookup. No real user files or SSH destinations are touched.
    const wrapper = `import os\nfrom unittest.mock import patch\nwith patch('os.path.expanduser', side_effect=lambda p: ${JSON.stringify(directory)} + p[1:] if p.startswith('~') else p):\n    exec(${JSON.stringify(script)})\n`;
    const result = spawnSync('python3', ['-'], { input: wrapper, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('test-secret'));
  };
  run(); run();
  const claude = JSON.parse(fs.readFileSync(path.join(directory, '.claude.json')));
  assert.deepEqual(claude.mcpServers['mac-industrial'], { type: 'http', url: 'http://127.0.0.1:19001/mcp?node=node-two', headers: { Authorization: 'Bearer test-secret' } });
  assert.equal(claude.mcpServers.other.command, 'other');
  assert.equal(claude.theme, 'dark');
  assert.ok(!claude.mcpServers['mac-industrial-mcp']);
  let settings = JSON.parse(fs.readFileSync(settingsPath));
  assert.deepEqual(settings.permissions.allow, ['Read']);
  assert.deepEqual(settings.permissions.ask, ['Bash', 'mcp__mac-industrial__mac_host_exec']);
  assert.deepEqual(settings.permissions.deny, ['mcp__mac-industrial__mac_host_exec']);
  for (const file of [settingsPath, path.join(directory, '.claude.json')]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  run(true);
  settings = JSON.parse(fs.readFileSync(settingsPath));
  assert.deepEqual(settings.permissions.allow, ['Read', 'mcp__mac-industrial__mac_host_exec']);
  assert.deepEqual(settings.permissions.ask, ['Bash']);
});

test('corrupt remote config is not overwritten during migration', (t) => {
  const directory = temp(t);
  fs.writeFileSync(path.join(directory, '.claude.json'), '{broken');
  const script = buildRemoteConfigPy({ node: { id: 'n', remoteWorkDir: directory }, port: 19001, token: 'test-secret' });
  const wrapper = `from unittest.mock import patch\nwith patch('os.path.expanduser', side_effect=lambda p: ${JSON.stringify(directory)} + p[1:]):\n    exec(${JSON.stringify(script)})\n`;
  const result = spawnSync('python3', ['-'], { input: wrapper, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(directory, '.claude.json'), 'utf8'), '{broken');
});

test('overlapping tool executions retain their node after await and never use another mirror', async (t) => {
  const directory = temp(t);
  const nodes = ['a', 'b'].map((id) => ({ id, remoteWorkDir: `/srv/${id}`, localWorkDir: path.join(directory, id) }));
  for (const n of nodes) fs.mkdirSync(n.localWorkDir);
  fs.writeFileSync(path.join(nodes[1].localWorkDir, 'only-b.txt'), 'b');
  const context = createRequestContext({ loadNodes: () => nodes, defaultWorkDir: directory });
  const execute = require('../mcp-server/tools')({ cfg: {}, PATHS: {}, ...context, runCommand: async (cmd, args) => {
    if (cmd === '/usr/sbin/screencapture') {
      await new Promise((resolve) => setTimeout(resolve, args.at(-1).includes('/a/') ? 30 : 5));
      fs.writeFileSync(args.at(-1), 'image');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  } });
  const outputs = await Promise.all(nodes.map((n) => context.run(n.id, async () => {
    assert.equal(context.resolveWorkPath('/root/work/only-b.txt'), path.join(n.localWorkDir, 'only-b.txt'));
    const result = await execute('mac_screen_capture', { return_inline_image: false, max_dimension_px: -1, output_filename: 'test.png' });
    assert.equal(context.getActiveNodeConfig().id, n.id);
    assert.equal(context.rewriteScriptPaths(`'/srv/${n.id}/x' '/root/work/x'`), `'${n.localWorkDir}/x' '${n.localWorkDir}/x'`);
    return result;
  })));
  for (let i = 0; i < nodes.length; i++) {
    assert.ok(outputs[i].includes(`${nodes[i].remoteWorkDir}/screenshots/test.png`));
    assert.ok(fs.existsSync(path.join(nodes[i].localWorkDir, 'screenshots/test.png')));
  }
  assert.throws(() => context.run('missing', () => {}), /Unknown node/);
  assert.throws(() => context.run(null, () => {}), /Multiple nodes/);
});

test('node registry preserves old IDs, rejects corruption, duplicate mirrors and SSH options', (t) => {
  const cfg = config(temp(t));
  const registry = createNodeRegistry(cfg);
  const nodes = registry.loadNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].enabled, false);
  assert.equal(nodes[0].sshHost, '');
  nodes[0].id = 'legacy-primary'; nodes[0].sshHost = 'user@my-server';
  registry.saveNodes(nodes);
  assert.equal(registry.getNodeById().id, 'legacy-primary');
  assert.throws(() => registry.getNodeById('unknown'), /Unknown/);
  assert.throws(() => registry.saveNodes([...nodes, { ...nodes[0], id: 'other' }]), /separate local mirror/);
  assert.throws(() => registry.saveNodes([{ ...nodes[0], sshHost: '-oProxyCommand=bad' }]), /Invalid SSH/);
  fs.writeFileSync(cfg.NODES_FILE, '{bad');
  assert.throws(() => registry.loadNodes());
  assert.equal(fs.readFileSync(cfg.NODES_FILE, 'utf8'), '{bad');
});

test('tunnel sockets distinguish data directories and ports; reverse binds are explicit loopback', (t) => {
  const cfg = config(temp(t));
  const node = { id: 'node-1', sshHost: 'example', desktopWebPort: 16080 };
  const sock = nodeTunnelSock(cfg, node);
  assert.notEqual(sock, nodeTunnelSock({ ...cfg, TAKT_HOME: cfg.TAKT_HOME + '-other' }, node));
  assert.notEqual(sock, nodeTunnelSock({ ...cfg, MCP_PORT: 19000 }, node));
  const args = tunnelArgs(cfg, node);
  assert.ok(args.includes('127.0.0.1:18990:127.0.0.1:18990'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('127.0.0.1:16080:127.0.0.1:6080'));
});

test('database upgrades legacy primary keys and scopes rename/delete to one machine', (t) => {
  const filename = path.join(temp(t), 'db.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, node_id TEXT NOT NULL, project_path TEXT NOT NULL,
    title TEXT NOT NULL, custom_title TEXT NOT NULL DEFAULT '', last_prompt TEXT NOT NULL DEFAULT '', turns INTEGER DEFAULT 1,
    size_bytes INTEGER DEFAULT 0, updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0);
    INSERT INTO sessions (id,node_id,project_path,title,updated_at) VALUES ('same','a','/root/work','A',1);`);
  old.close();
  const db = require('../server/repositories/workbench-db')(filename);
  t.after(() => db.workbenchDb.close());
  db.stmtRegisterLocalSession.run('same', 'b', '/root/work', 'B', 2);
  db.stmtRenameSession.run('renamed', 'renamed', 3, 'a', 'same');
  db.stmtSoftDeleteSession.run(4, 'a', 'same');
  const rows = db.workbenchDb.prepare('SELECT node_id,title,deleted FROM sessions ORDER BY node_id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ node_id: 'a', title: 'renamed', deleted: 1 }, { node_id: 'b', title: 'B', deleted: 0 }]);
});

test('tunnel repair is single-flight, authenticates over stdin and never kills port owners', async (t) => {
  const cfg = config(temp(t));
  const node = { id: 'a', sshHost: 'my-host', remoteWorkDir: '/root/work', enabled: true };
  const calls = [];
  const watchdog = require('../mcp-server/watchdog')({ cfg, TOOLS: [], MCP_TOKEN: 'test-secret', loadConfiguredNodes: () => [node],
    runCommand: async (cmd, args, options) => { calls.push({ cmd, args, options }); await Promise.resolve(); return { exitCode: 0, stdout: '', stderr: '' }; },
  });
  await Promise.all([watchdog.healNodeTunnel(node), watchdog.healNodeTunnel(node)]);
  assert.equal(calls.filter((c) => c.args.includes('-Nf')).length, 1);
  assert.ok(calls.every((c) => c.cmd === 'ssh' && !c.args.join(' ').match(/kill|fuser|test-secret/)));
  const refresh = calls.find((c) => c.args.includes('python3 -'));
  assert.ok(refresh.options.input.includes('save_private'));
  assert.ok(!calls.find((c) => c.args.includes('-Nf')).args.some((a) => a.includes(String(cfg.EDA_PORT))));
  const failing = [];
  const broken = require('../mcp-server/watchdog')({ cfg, TOOLS: [], MCP_TOKEN: 'test-secret', loadConfiguredNodes: () => [node],
    runCommand: async (cmd, args) => { failing.push({ cmd, args }); return { exitCode: args.includes('-Nf') ? 1 : 0 }; },
  });
  await assert.rejects(broken.healNodeTunnel(node), /remote port ownership/);
  assert.equal(failing.length, 2);
});

test('native launch configuration resolves user env before deriving runtime paths', async (t) => {
  const directory = temp(t);
  const alternate = path.join(directory, 'other');
  fs.writeFileSync(path.join(directory, 'env'), `TAKT_PORT=31999\nTAKT_HOME='${alternate}'\n`);
  const result = await exec('bash', [path.resolve(__dirname, '../scripts/runtime-config.sh')], {
    env: { ...process.env, TAKT_HOME: directory, TAKT_SSH_SOCKET_DIR: path.join(directory, 'sockets') },
  });
  assert.equal(JSON.parse(result.stdout).url, 'http://127.0.0.1:31999');
  assert.ok(fs.existsSync(path.join(alternate, 'run')));
  assert.ok(!fs.existsSync(path.join(directory, 'run')));
});
