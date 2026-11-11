'use strict';
/**
 * TAKT-UI-CC — shared runtime configuration.
 *
 * Every path / port the system uses is derived from here, so nothing is tied to one user's machine.
 * All values can be overridden with environment variables (see docs/CONFIGURATION.md).
 */
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();

// Runtime data directory (nodes.json, SQLite DB, logs, per-node work folders live here).
const TAKT_HOME = path.resolve(process.env.TAKT_HOME || path.join(HOME, '.takt-ai'));

function syncthingConfigCandidates() {
  return [
    ...(process.platform === 'win32' ? [
      path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData/Local'), 'Syncthing/config.xml'),
      path.join(process.env.APPDATA || path.join(HOME, 'AppData/Roaming'), 'Syncthing/config.xml'),
    ] : []),
    path.join(HOME, 'Library/Application Support/Syncthing/config.xml'), // macOS
    path.join(HOME, '.local/state/syncthing/config.xml'), // Linux (new)
    path.join(HOME, '.config/syncthing/config.xml'), // Linux (old)
  ];
}

const fs = require('node:fs');
const { getOrCreateToken } = require('./lib/mcp-token');
function getMcpToken() {
  return getOrCreateToken(TAKT_HOME, process.env.TAKT_MCP_TOKEN);
}
function port(value, fallback, name, max = 65535) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new Error(`Invalid ${name}: ${value}`);
  return number;
}
const MCP_HOST = process.env.TAKT_MCP_HOST || '127.0.0.1';
if (MCP_HOST !== '127.0.0.1') throw new Error('TAKT_MCP_HOST must be 127.0.0.1 (local desktop client)');

module.exports = {
  HOME,
  getMcpToken,
  MCP_HOST,
  TAKT_HOME,
  REPO_ROOT: __dirname,

  // Web workbench (browser / desktop shell loads this)
  PORT: port(process.env.TAKT_PORT || process.env.PORT, 3080, 'TAKT_PORT'),
  // Local MCP server, reverse-tunnelled to every Linux node
  MCP_PORT: port(process.env.TAKT_MCP_PORT || process.env.MAC_MCP_PORT, 18765, 'TAKT_MCP_PORT'),
  // EasyEDA bridge (optional MCP tool pack)
  EDA_PORT: port(process.env.TAKT_EDA_PORT, 49620, 'TAKT_EDA_PORT', 65526),

  NODES_FILE: path.join(TAKT_HOME, 'nodes.json'),
  SESSION_TITLES_FILE: path.join(TAKT_HOME, 'session-titles.json'),
  DB_FILE: path.join(TAKT_HOME, 'takt-workbench.sqlite'),
  LOG_DIR: path.join(TAKT_HOME, 'logs'),
  DEFAULT_WORK_DIR: path.join(TAKT_HOME, 'work'),

  // ControlMaster sockets for the MCP reverse tunnels (one per node)
  SSH_SOCKET_DIR: path.resolve(process.env.TAKT_SSH_SOCKET_DIR || path.join(HOME, '.ssh', 'sockets')),
  ENABLE_EDA_TUNNEL: process.env.TAKT_ENABLE_EDA_TUNNEL === '1',
  AUTO_ALLOW_HOST_EXEC: process.env.TAKT_AUTO_ALLOW_HOST_EXEC === '1',
  SUPERVISE_MCP: process.env.TAKT_SUPERVISE_MCP !== '0',
  WATCHDOG_ENABLED: process.env.TAKT_WATCHDOG !== '0',

  // Optional: also drop a convenience symlink "<alias> -> <local work dir>" into this folder
  WORKSPACE_LINK_DIR: process.env.TAKT_WORKSPACE_LINK_DIR || '',

  // First node created on a fresh install (no SSH host bound yet)
  PRIMARY_NODE_ID: 'node-1',

  syncthingConfigCandidates,
  findSyncthingConfig() {
    if (process.env.TAKT_SYNCTHING_CONFIG) return process.env.TAKT_SYNCTHING_CONFIG;
    return syncthingConfigCandidates().find((p) => fs.existsSync(p)) || syncthingConfigCandidates()[0];
  },
  SYNCTHING_URL: process.env.TAKT_SYNCTHING_URL || 'http://127.0.0.1:8384',

  // Optional external tool locations for the MCP tool pack
  EASYEDA_BRIDGE_SCRIPT: process.env.TAKT_EASYEDA_BRIDGE || '',
  IDF_EXPORT_SH: process.env.TAKT_IDF_EXPORT || path.join(HOME, 'esp/esp-idf/export.sh'),
  IDF_EXPORT_PS1: process.env.TAKT_IDF_EXPORT_PS1 || '',
  ESP_PYTHON_ENV: process.env.TAKT_ESP_PYTHON_ENV || path.join(HOME, '.espressif/python_env/idf5.1_py3.9_env'),
};
