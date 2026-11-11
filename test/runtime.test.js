'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

test('portable service lifecycle is idempotent and stops both authenticated services', { timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-runtime-'));
  const servers = [net.createServer(), net.createServer()];
  for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  const ports = servers.map(s => s.address().port);
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
  const env = { ...process.env, TAKT_HOME: directory, TAKT_PORT: String(ports[0]), TAKT_MCP_PORT: String(ports[1]), TAKT_MCP_HOST: '127.0.0.1', TAKT_WATCHDOG: '0', TAKT_SUPERVISE_MCP: '0', TAKT_SSH_SOCKET_DIR: path.join(directory, 'sockets') };
  delete env.TAKT_MCP_TOKEN;
  const script = 'const r=require("./scripts/runtime"); (async()=>{await r.start();await r.start();await r.stop()})().catch(e=>{console.error(e);process.exitCode=1})';
  const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    const tokenFile = path.join(directory, 'mcp-token');
    const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
    for (const [index, route] of ['/api/shutdown', '/shutdown'].entries()) {
      try { await fetch(`http://127.0.0.1:${ports[index]}${route}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(2000) }); } catch {}
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  for (const port of ports) await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }));
  assert.ok(!output.includes(fs.readFileSync(path.join(directory, 'mcp-token'), 'utf8').trim()));
});
