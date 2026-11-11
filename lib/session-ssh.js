'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

function newSessionEnv() {
  const address = process.platform === 'win32'
    ? '\\\\.\\pipe\\takt-ssh-' + randomBytes(16).toString('hex')
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-ssh-')), 'agent');
  return { TAKT_SSH_AGENT: address, SSH_AUTH_SOCK: address };
}

function sessionSshArgs(args, env = process.env) {
  if (!env.TAKT_SSH_AGENT) return args;
  // First values win in OpenSSH: never consult the persistent system agent,
  // add decrypted keys to another agent, forward this agent, or reuse an
  // authenticated connection belonging to another application/session.
  return ['-o', `IdentityAgent=${env.TAKT_SSH_AGENT}`, '-o', 'AddKeysToAgent=no',
    '-o', 'ForwardAgent=no', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none', ...args];
}
module.exports = { newSessionEnv, sessionSshArgs };
