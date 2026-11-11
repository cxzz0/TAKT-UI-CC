'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Windows accepts literal KEY=value entries, with optional quotes; never runs shell code.
function load(env = process.env, home = os.homedir()) {
  const file = path.join(env.TAKT_HOME || path.join(home, '.takt-ai'), 'env');
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const raw of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const match = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/);
    if (!match) throw new Error('Invalid Windows env entry; use KEY=value');
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    env[match[1]] = value;
  }
}
module.exports = { load };
