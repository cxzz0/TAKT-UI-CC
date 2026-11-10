'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Publish a complete token atomically: the workbench and MCP start concurrently.
function getOrCreateToken(directory, override) {
  if (override !== undefined) {
    if (!override.trim() || /[\r\n]/.test(override)) throw new Error('TAKT_MCP_TOKEN must be a non-empty single-line token');
    return override;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'mcp-token');
  const read = () => {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!token || /[\r\n]/.test(token)) throw new Error('Invalid MCP token file; restore it or rotate the token');
    fs.chmodSync(file, 0o600);
    return token;
  };
  try { return read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temp, crypto.randomBytes(24).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return read();
  } finally { fs.rmSync(temp, { force: true }); }
}

module.exports = { getOrCreateToken };
