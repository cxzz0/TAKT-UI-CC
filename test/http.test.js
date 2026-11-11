'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');

async function freePorts() {
  const servers = [net.createServer(), net.createServer()];
  for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  return ports;
}
function request(base, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

test('isolated workbench and MCP: auth, assets, node-scoped RPC and session mutations', { timeout: 60000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-http-'));
  const root = path.resolve(__dirname, '..');
  const [uiPort, mcpPort] = await freePorts();
  const ui = `http://127.0.0.1:${uiPort}`, mcp = `http://127.0.0.1:${mcpPort}`;
  const env = { ...process.env, TAKT_HOME: directory, TAKT_PORT: String(uiPort), TAKT_MCP_PORT: String(mcpPort),
    TAKT_SSH_SOCKET_DIR: path.join(directory, 'sockets'), TAKT_WATCHDOG: '0', TAKT_SUPERVISE_MCP: '0',
    TAKT_MCP_HOST: '127.0.0.1', TAKT_REQUIRE_MCP_TOKEN: '0' };
  delete env.TAKT_MCP_TOKEN;
  const children = [];
  let logs = '';
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const file of ['mcp-server/server.js', 'server/server.js']) {
    const child = spawn(process.execPath, [file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
    children.push(child);
  }
  for (const url of [ui + '/api/health', mcp + '/health']) {
    let ready = false;
    for (let n = 0; n < 80; n++) {
      try { ready = (await fetch(url)).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, logs);
  }
  const token = fs.readFileSync(path.join(directory, 'mcp-token'), 'utf8').trim();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await request(ui, '/')).status, 200);
  for (const asset of ['workbench.js', 'workbench.css', 'icons.js', 'nodes.js']) {
    assert.equal((await request(ui, '/assets/' + asset)).status, 200);
  }
  assert.equal((await request(ui, '/assets/../../config.js')).status, 404);
  assert.equal((await request(ui, '/api/tree', { headers: { Host: 'evil.test' } })).status, 403);
  assert.equal((await request(ui, '/api/tags', { method: 'POST', headers: { Origin: 'http://localhost:9999' }, body: { name: 'bad' } })).status, 403);
  assert.equal((await request(ui, '/api/tags', { method: 'POST', headers: { Origin: ui }, body: { name: 'test' } })).status, 200);
  const initial = (await request(ui, '/api/tree')).json();
  assert.equal(initial.nodes.length, 1); assert.equal(initial.nodes[0].id, 'node-1'); assert.equal(initial.nodes[0].enabled, false);
  for (const route of ['/mcp', '/messages', '/sse', '/system-heal', '/remote-desktop']) {
    assert.equal((await request(mcp, route, { method: 'POST', body: rpc })).status, 401, route);
    assert.equal((await request(mcp, route, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: rpc })).status, 401);
  }
  assert.equal((await request(mcp, '/mcp?token=' + token, { method: 'POST', body: rpc })).status, 401);
  assert.equal((await request(mcp, '/mcp', { method: 'POST', headers: { 'x-takt-token': token }, body: rpc })).status, 401);
  assert.equal((await request(mcp, '/mcp', { method: 'POST', headers: { ...headers, Origin: 'http://127.0.0.1:9999' }, body: rpc })).status, 403);
  const authorized = await request(mcp, '/mcp', { method: 'POST', headers, body: rpc });
  assert.equal(authorized.status, 200); assert.equal(authorized.json().result.tools.length, process.platform === 'win32' ? 21 : 23);
  if (process.platform === 'win32') assert.ok(!authorized.json().result.tools.some(tool => tool.name.startsWith('xcode_')));
  assert.equal(authorized.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(mcp, '/remote-desktop', { headers })).status, 405);
  // The UI proxy supplies auth on the server, and preserves downstream validation.
  assert.equal((await request(ui, '/api/remote-desktop', { method: 'POST', body: { nodeId: 'missing' } })).status, 400);
  assert.equal((await request(ui, '/api/remote-desktop')).status, 404);
  assert.equal((await request(ui, '/api/nodes', { method: 'POST', body: { id: 'node-2', localWorkAlias: 'work2', enabled: false } })).status, 200);
  fs.writeFileSync(path.join(directory, 'work', 'a.txt'), 'a');
  fs.writeFileSync(path.join(directory, 'work2', 'b.txt'), 'b');
  const calls = await Promise.all(['node-1', 'node-2'].map((id) => request(mcp, '/mcp?node=' + id, {
    method: 'POST', headers, body: { ...rpc, method: 'tools/call', params: { name: 'work_sync_status', arguments: {} } },
  })));
  const fileLists = calls.map((r) => JSON.parse(r.json().result.content[0].text).files.map((f) => f.name));
  assert.ok(fileLists[0].includes('a.txt') && !fileLists[0].includes('b.txt'));
  assert.ok(fileLists[1].includes('b.txt') && !fileLists[1].includes('a.txt'));
  assert.equal((await request(mcp, '/mcp?node=missing', { method: 'POST', headers, body: { ...rpc, method: 'tools/call', params: { name: 'work_sync_status' } } })).status, 400);
  fs.symlinkSync(directory, path.join(directory, 'work', 'secret'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await request(mcp, '/work/secret/mcp-token?node=node-1')).status, 404);
  assert.equal((await request(mcp, '/work/a.txt?node=node-1')).text, 'a');
  assert.equal((await request(mcp, '/work/a.txt?node=node-2')).status, 404);
  fs.writeFileSync(path.join(directory, 'work', '中文 file.txt'), 'preview OK');
  for (const file of ['/root/work/中文 file.txt', path.join(directory, 'work', '中文 file.txt')]) {
    const query = new URLSearchParams({ path: file, cwd: '/root/work', nodeId: 'node-1' });
    assert.equal((await request(ui, '/api/file-content?' + query)).json().content, 'preview OK');
  }
  const command = process.platform === 'win32' ? "Write-Output ('TAKT_' + 'HOST_OK')" : "printf 'TAKT_HOST_OK'";
  const executed = await request(mcp, '/mcp?node=node-1', { method: 'POST', headers, body: { ...rpc, method: 'tools/call', params: { name: 'mac_host_exec', arguments: { command } } } });
  assert.equal(executed.json().result.isError, false);
  assert.ok(executed.json().result.content[0].text.includes('TAKT_HOST_OK'));
  for (const nodeId of ['node-1', 'node-2']) assert.equal((await request(ui, '/api/sessions/register', {
    method: 'POST', body: { id: 'same-session', nodeId, title: 'original', cwd: '/root/work' },
  })).status, 200);
  await request(ui, '/api/sessions/rename', { method: 'POST', body: { id: 'same-session', nodeId: 'node-1', title: 'changed' } });
  let tree = (await request(ui, '/api/tree')).json();
  let sessions = tree.folders.flatMap((f) => f.sessions);
  assert.equal(sessions.find((s) => s.nodeId === 'node-1').title, 'changed');
  assert.equal(sessions.find((s) => s.nodeId === 'node-2').title, 'original');
  await request(ui, '/api/sessions?id=same-session&nodeId=node-1', { method: 'DELETE' });
  tree = (await request(ui, '/api/tree')).json(); sessions = tree.folders.flatMap((f) => f.sessions);
  assert.deepEqual(sessions.map((s) => s.nodeId), ['node-2']);
  const ws = new WebSocket(ui.replace('http:', 'ws:') + '/ws/term?nodeId=missing');
  const closed = once(ws, 'close');
  await closed;
  assert.equal((await request(ui, '/api/health')).status, 200);
  assert.ok(children.every((c) => c.exitCode === null), logs);
  assert.ok(!logs.includes(token));
  for (const [base, route] of [[ui, '/api/shutdown'], [mcp, '/shutdown']]) {
    assert.equal((await request(base, route, { method: 'POST' })).status, 401);
    assert.equal((await request(base, route, { method: 'POST', headers })).status, 200);
  }
});
