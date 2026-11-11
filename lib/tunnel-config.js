'use strict';
const path = require('node:path');
const crypto = require('node:crypto');

function nodeTunnelSock(cfg, node) {
  const key = crypto.createHash('sha256').update(`${cfg.TAKT_HOME}\0${node.id}\0${cfg.MCP_PORT}\0${cfg.EDA_PORT}`).digest('hex').slice(0, 24);
  return path.join(cfg.SSH_SOCKET_DIR, `takt-${key}.sock`);
}

function tunnelArgs(cfg, node, windows = process.platform === 'win32') {
  return [
    ...(windows ? ['-T'] : ['-M', '-S', nodeTunnelSock(cfg, node), '-Nf']),
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    ...(windows ? ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ForkAfterAuthentication=no'] : []),
    '-o', 'ClearAllForwardings=no',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2', '-o', 'TCPKeepAlive=yes',
    '-R', `127.0.0.1:${cfg.MCP_PORT}:127.0.0.1:${cfg.MCP_PORT}`,
    ...(cfg.ENABLE_EDA_TUNNEL ? ['-R', `127.0.0.1:${cfg.EDA_PORT}:127.0.0.1:${cfg.EDA_PORT}`] : []),
    ...(node.syncthingTunnelPort ? ['-L', `127.0.0.1:${node.syncthingTunnelPort}:127.0.0.1:22000`] : []),
    ...(node.desktopWebPort ? ['-L', `127.0.0.1:${node.desktopWebPort}:127.0.0.1:6080`] : []),
    ...(node.desktopVncPort ? ['-L', `127.0.0.1:${node.desktopVncPort}:127.0.0.1:5901`] : []),
    node.sshHost,
    // An explicit acknowledgement proves that OpenSSH has installed every forward.
    // Keep stdin open until this instance stops its child; no ControlMaster on Windows.
    ...(windows ? ["printf 'TAKT_TUNNEL_READY\\n'; cat"] : []),
  ];
}

module.exports = { nodeTunnelSock, tunnelArgs };
