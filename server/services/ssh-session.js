'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasBearerToken } = require('../../lib/http-security');

module.exports = function sshSessionRoutes(agent) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const candidates = ['id_ed25519', 'id_rsa', 'id_ecdsa'].map(name => path.join(os.homedir(), '.ssh', name));
  const defaultKey = candidates.find(file => fs.existsSync(file)) || candidates[0];
  const reply = (res, code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  return async (req, res, pathname) => {
    if (!pathname.startsWith('/api/ssh-session')) return false;
    if (req.method === 'GET' && pathname === '/api/ssh-session') {
      reply(res, 200, { enabled: Boolean(agent), ...(agent ? { ...agent.status(), csrfToken, defaultKey } : {}) });
      return true;
    }
    if (req.method !== 'POST' || pathname !== '/api/ssh-session/unlock') { reply(res, 404, { ok: false }); return true; }
    // An independent per-launch nonce, never the MCP token known by remote nodes.
    if (!agent || !hasBearerToken({ authorization: 'Bearer ' + req.headers['x-takt-ssh-session'] }, csrfToken)) {
      reply(res, 403, { ok: false, error: '请从本机工作台解锁 SSH' }); return true;
    }
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { reply(res, 415, { ok: false }); return true; }
    let body;
    let secret;
    const chunks = [];
    try {
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) throw new Error('请求过大');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      try { body = JSON.parse(raw.toString('utf8')); } finally { raw.fill(0); }
      if (!body || typeof body !== 'object' || typeof body.passphrase !== 'string' || body.passphrase.length > 8192) throw new Error('请输入私钥口令');
      secret = Buffer.from(body.passphrase, 'utf8');
      body.passphrase = '';
      const status = await agent.unlock(body.keyFile, secret);
      reply(res, 200, { ok: true, ...status });
    } catch (error) {
      reply(res, 400, { ok: false, error: error.message.startsWith('无法解锁') ? error.message : '解锁请求无效' });
    } finally {
      secret?.fill(0);
      if (body && typeof body === 'object') body.passphrase = '';
      for (const chunk of chunks) chunk.fill(0);
    }
    return true;
  };
};
