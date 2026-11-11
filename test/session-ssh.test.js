'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Server, createAgent, utils: { generateKeyPairSync, parseKey } } = require('ssh2');
const { SessionAgent } = require('../lib/session-agent');
const { newSessionEnv, sessionSshArgs } = require('../lib/session-ssh');
const platform = require('../lib/platform');
const exec = promisify(execFile);
const passphrase = 'test-only-会话-口令';
function identities(address) {
  return new Promise((resolve, reject) => createAgent(address).getIdentities((error, keys) => error ? reject(error) : resolve(keys)));
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('OpenSSH preserves the session agent pipe through environment lookup instead of config escaping', async () => {
  const address = '\\\\.\\pipe\\takt-ssh-test';
  const env = platform.childEnv({ TAKT_SSH_AGENT: address, SSH_AUTH_SOCK: 'a-different-system-agent' });
  assert.equal(env.SSH_AUTH_SOCK, address);
  const result = await exec(platform.ssh, sessionSshArgs(['-G', '-F', 'none', 'test@localhost'], env), { env, windowsHide: true, timeout: 8000 });
  assert.match(result.stdout, /^identityagent SSH_AUTH_SOCK\r?$/m);
});

test('session terminal retains Documents/work, work and home fallback when its configured directory is unusable', { skip: process.platform === 'win32' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-cwd-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, '.local', 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\ncase "$1" in\nhas-session) exit 1;;\nnew-session) printf "%s" "$6" > "$HOME/tmux-cwd";;\nattach-session) cat "$HOME/tmux-cwd";;\nesac\n', { mode: 0o700 });
  const blocked = path.join(directory, 'not-a-directory'); fs.writeFileSync(blocked, 'test');
  const documentsWork = path.join(directory, 'Documents', 'work'); fs.mkdirSync(documentsWork, { recursive: true });
  const command = require('../lib/ssh').remoteSessionCommand('test', path.join(blocked, 'project'));
  const run = async (prefix = '') => (await exec('/bin/bash', ['-c', prefix + command], { env: { ...process.env, HOME: directory } })).stdout.trim();
  assert.equal(await run(), documentsWork);
  const denyDocuments = 'cd() { if [ "$1" = "$HOME/Documents/work" ]; then return 1; fi; builtin cd "$@"; }; ';
  assert.equal(await run(denyDocuments), path.join(directory, 'work'), 'unenterable Documents/work must not be passed to tmux');
  fs.rmdirSync(documentsWork);
  assert.equal(await run(), path.join(directory, 'work'));
  fs.rmdirSync(path.join(directory, 'work')); fs.writeFileSync(path.join(directory, 'work'), 'test');
  assert.equal(await run(), directory);
  fs.mkdirSync(documentsWork);
  assert.equal(await run(denyDocuments), directory, 'tmux receives HOME when both workspace fallbacks are inaccessible');
});

for (const [type, options] of [['ed25519', {}], ['rsa', { bits: 2048 }], ['ecdsa', { bits: 256 }]]) {
  test(`native OpenSSH uses the session-only ${type} key; lock and exit revoke it`, { timeout: 30000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-agent-test-'));
    const env = newSessionEnv();
    const agent = new SessionAgent(env.TAKT_SSH_AGENT);
    await agent.start();
    const pair = generateKeyPairSync(type, { ...options, cipher: 'aes256-ctr', passphrase });
    const keyFile = path.join(directory, '私钥 key.pem'); fs.writeFileSync(keyFile, pair.private, { mode: 0o600 });
    const publicKey = parseKey(pair.public);
    const host = generateKeyPairSync('ed25519');
    const clients = new Set();
    const server = new Server({ hostKeys: [host.private] }, client => {
      clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
      client.on('authentication', ctx => {
        if (ctx.method === 'publickey' && ctx.key.data.equals(publicKey.getPublicSSH())
          && (!ctx.signature || publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) ctx.accept();
        else ctx.reject(['publickey']);
      });
      client.on('ready', () => client.on('session', accept => accept().on('exec', accept => {
        const stream = accept(); stream.write('TAKT_SESSION_OK\n'); stream.exit(0); stream.end();
      })));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => {
      if (!agent.closed) await agent.close();
      for (const client of clients) client.destroy();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const port = server.address().port;
    const knownHosts = path.join(directory, 'known_hosts');
    fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${host.public}\n`);
    const args = sessionSshArgs(['-F', 'none', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'IdentityFile=none', '-o', 'IdentitiesOnly=no', '-p', String(port), 'test@127.0.0.1', 'true'], env);
    const connect = () => exec(platform.ssh, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 8000 });
    assert.deepEqual(await identities(agent.address), []);
    await assert.rejects(connect());
    const wrong = Buffer.from('wrong'); await assert.rejects(agent.unlock(keyFile, wrong));
    assert.ok(wrong.every(byte => byte === 0));
    assert.equal(agent.unlocked, false);
    const secret = Buffer.from(passphrase);
    await agent.unlock(keyFile, secret);
    assert.ok(secret.every(byte => byte === 0));
    const listed = await identities(agent.address);
    assert.equal(listed.length, 1); assert.equal(listed[0].isPrivateKey(), false);
    assert.match((await connect()).stdout, /TAKT_SESSION_OK/);
    assert.match((await connect()).stdout, /TAKT_SESSION_OK/, 'subsequent connections reuse the unlocked key');
    agent.lock();
    assert.deepEqual(await identities(agent.address), []);
    await assert.rejects(connect());
    await agent.close();
    await assert.rejects(identities(agent.address));
    const restarted = new SessionAgent(agent.address);
    // On POSIX the old private socket directory was removed at shutdown.
    if (process.platform !== 'win32') fs.mkdirSync(path.dirname(agent.address), { mode: 0o700 });
    await restarted.start();
    try { assert.deepEqual(await identities(agent.address), []); await assert.rejects(connect()); }
    finally { await restarted.close(); }
    assert.equal(fs.readFileSync(keyFile, 'utf8'), pair.private, 'original encrypted key is unchanged');
  });
}

test('workbench unlock API uses its own nonce, rejects cross-origin requests, and clears keys on shutdown', { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-unlock-test-'));
  const dataDir = path.join(directory, 'data');
  const pair = generateKeyPairSync('ed25519', { cipher: 'aes256-ctr', passphrase });
  const keyFile = path.join(directory, 'encrypted-key'); fs.writeFileSync(keyFile, pair.private, { mode: 0o600 });
  const port = await freePort(); const sessionEnv = newSessionEnv();
  const env = { ...process.env, ...sessionEnv, TAKT_HOME: dataDir, TAKT_PORT: String(port), TAKT_SUPERVISE_MCP: '0', TAKT_WATCHDOG: '0' };
  delete env.TAKT_MCP_TOKEN;
  const child = spawn(process.execPath, ['server/server.js'], { cwd: path.join(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let state;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { state = await (await fetch(base + '/api/ssh-session', { signal: AbortSignal.timeout(1000) })).json(); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(state?.csrfToken, output);
  assert.equal(state.enabled, true); assert.equal(state.unlocked, false);
  const body = JSON.stringify({ keyFile, passphrase });
  const send = (token, origin = base) => fetch(base + '/api/ssh-session/unlock', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Takt-SSH-Session': token, Origin: origin }, body,
  });
  assert.equal((await send('wrong')).status, 403);
  assert.equal((await send(state.csrfToken, 'https://example.com')).status, 403);
  const mcpToken = fs.readFileSync(path.join(dataDir, 'mcp-token'), 'utf8').trim();
  assert.equal((await send(mcpToken)).status, 403, 'remote MCP credential cannot unlock the session');
  const response = await send(state.csrfToken); assert.equal(response.status, 200);
  const text = await response.text(); assert.ok(!text.includes(passphrase)); assert.ok(!text.includes('PRIVATE KEY'));
  assert.equal((await identities(sessionEnv.TAKT_SSH_AGENT)).length, 1);
  const status = await (await fetch(base + '/api/ssh-session')).json(); assert.equal(status.unlocked, true);
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' + mcpToken } })).status, 200);
  await exited;
  await assert.rejects(identities(sessionEnv.TAKT_SSH_AGENT));
  assert.ok(!output.includes(passphrase)); assert.ok(!output.includes('PRIVATE KEY'));
  function checkFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) checkFiles(file);
      else {
        const contents = fs.readFileSync(file).toString('utf8');
        assert.ok(!contents.includes(passphrase), file); assert.ok(!contents.includes('PRIVATE KEY'), file);
      }
    }
  }
  checkFiles(dataDir);
});
