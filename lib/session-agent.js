'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AgentProtocol, utils: { parseKey } } = require('ssh2');
// Pinned ssh2 version; agent replies need SSH wire signatures (not ECDSA DER).
const { convertSignature } = require('ssh2/lib/protocol/utils');

class SessionAgent {
  constructor(address) {
    this.address = address;
    this.keys = new Map();
    this.sockets = new Set();
    this.epoch = 0;
    this.closed = false;
    this.server = net.createServer(socket => this.accept(socket));
    this.server.on('error', () => {});
  }
  get unlocked() { return this.keys.size > 0; }
  status() {
    return { unlocked: this.unlocked, keys: [...this.keys.values()].map(k => ({ name: k.name, fingerprint: k.fingerprint })) };
  }
  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.address, () => { this.server.removeListener('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') fs.chmodSync(this.address, 0o600);
  }
  accept(socket) {
    if (this.closed) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    const protocol = new AgentProtocol(false);
    protocol.on('error', () => socket.destroy());
    protocol.on('identities', req => protocol.getIdentitiesReply(req, [...this.keys.values()].map(k => k.key)));
    protocol.on('sign', (req, publicKey, data, options) => {
      const entry = this.keys.get(publicKey.getPublicSSH().toString('base64'));
      if (!entry) { protocol.failureReply(req); return; }
      const signature = entry.key.sign(data, options.hash);
      if (signature instanceof Error) protocol.failureReply(req);
      else protocol.signReply(req, convertSignature(signature, entry.key.type));
    });
    // Only forward complete identity/sign frames. ssh2's server parser does
    // not consume the payload of unknown requests (including OpenSSH's
    // session-bind extension), so reject those here without desynchronizing
    // the following request. There is no add/export/persist-key API.
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (length < 1 || length > 262144) { socket.destroy(); return; }
        if (pending.length < length + 4) return;
        const packet = pending.subarray(0, length + 4);
        pending = pending.subarray(length + 4);
        if (packet[4] === 11 || packet[4] === 13) protocol.write(packet);
        else socket.write(Buffer.from([0, 0, 0, 1, packet[4] === 27 ? 28 : 5]));
      }
    });
    socket.once('close', () => protocol.destroy());
    protocol.pipe(socket);
  }
  async unlock(file, passphrase) {
    const epoch = this.epoch;
    if (typeof file !== 'string' || !file.trim() || file.length > 4096 || /[\0\r\n]/.test(file)) throw new Error('请输入私钥文件的完整路径');
    file = file.replace(/^~(?=[/\\])/, os.homedir());
    if (!path.isAbsolute(file)) throw new Error('私钥路径必须为绝对路径');
    let source;
    try {
      const handle = await fsp.open(file, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65536) throw new Error('invalid key file');
        source = Buffer.alloc(65537);
        const { bytesRead } = await handle.read(source, 0, source.length, 0);
        if (bytesRead > 65536) throw new Error('invalid key file');
        const key = parseKey(source.subarray(0, bytesRead), passphrase);
        if (key instanceof Error || Array.isArray(key) || !key.isPrivateKey()) throw new Error('invalid key or passphrase');
        if (this.closed || epoch !== this.epoch) throw new Error('session ended');
        const publicKey = key.getPublicSSH();
        const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
        this.keys.set(publicKey.toString('base64'), { key, name: path.basename(file), fingerprint });
        return this.status();
      } finally { await handle.close(); }
    } catch {
      // Never return parser diagnostics, file contents, or the passphrase.
      throw new Error('无法解锁：请检查私钥路径、格式和口令');
    } finally {
      source?.fill(0);
      if (Buffer.isBuffer(passphrase)) passphrase.fill(0);
    }
  }
  lock() {
    this.epoch++;
    this.keys.clear();
    for (const socket of this.sockets) socket.destroy();
  }
  async close() {
    this.closed = true;
    this.lock();
    await new Promise(resolve => this.server.close(resolve));
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.address); } catch {}
      const dir = path.dirname(this.address);
      if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('takt-ssh-')) { try { fs.rmdirSync(dir); } catch {} }
    }
  }
}
module.exports = { SessionAgent };
