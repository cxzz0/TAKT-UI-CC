'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
module.exports = function createNodeRegistry(cfg) {
const BASE_TAKT_DIR = cfg.TAKT_HOME;
const WORKSPACE_LINK_DIR = cfg.WORKSPACE_LINK_DIR;
const NODES_FILE = cfg.NODES_FILE;
const LOCAL_WORK_DIR = cfg.DEFAULT_WORK_DIR;
const DEFAULT_NODES = [{
  id: cfg.PRIMARY_NODE_ID, name: 'Linux 节点 1', badge: 'LX-1', sshHost: '',
  remoteWorkDir: '/root/work', localWorkDir: LOCAL_WORK_DIR, localWorkAlias: 'work',
  syncthingFolderId: 'takt-work', syncthingDeviceId: '', enabled: false,
}];

function ensureNodeLocalDirAndSymlink(node) {
  try {
    const alias = String(node.localWorkAlias || path.basename(node.localWorkDir || 'work2')).replace(/[^a-zA-Z0-9_-]/g, '');
    const localDir = node.localWorkDir || path.join(BASE_TAKT_DIR, alias);
    node.localWorkDir = localDir;
    node.localWorkAlias = alias;
    fs.mkdirSync(localDir, { recursive: true });

    // Seed CLAUDE.md and .stignore if new workN directory
    const srcClaude = path.join(LOCAL_WORK_DIR, 'CLAUDE.md');
    const dstClaude = path.join(localDir, 'CLAUDE.md');
    if (fs.existsSync(srcClaude) && !fs.existsSync(dstClaude)) {
      try { fs.copyFileSync(srcClaude, dstClaude); } catch {}
    }
    const srcStignore = path.join(LOCAL_WORK_DIR, '.stignore');
    const dstStignore = path.join(localDir, '.stignore');
    if (fs.existsSync(srcStignore) && !fs.existsSync(dstStignore)) {
      try { fs.copyFileSync(srcStignore, dstStignore); } catch {}
    }

    // Create convenience symlink in $TAKT_WORKSPACE_LINK_DIR/<alias>
    if (WORKSPACE_LINK_DIR && fs.existsSync(WORKSPACE_LINK_DIR)) {
      const linkPath = path.join(WORKSPACE_LINK_DIR, alias);
      if (!fs.existsSync(linkPath)) {
        try { fs.symlinkSync(localDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
      }
    }
  } catch {}
}

function readNodes() {
  try {
    const raw = JSON.parse(fs.readFileSync(NODES_FILE, 'utf8'));
    if (!raw || !Array.isArray(raw.nodes) || !raw.nodes.length) throw new Error('nodes.json must contain at least one node');
    validateNodes(raw.nodes);
    return raw.nodes;
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_NODES.map((n) => ({ ...n }));
    throw error;
  }
}
function validateNodes(nodes) {
  const ids = new Set();
  const paths = new Set();
  for (const node of nodes) {
    if (!/^[a-zA-Z0-9_-]+$/.test(node.id || '') || ids.has(node.id)) throw new Error('Invalid or duplicate node ID');
    if (node.sshHost && (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/.test(node.sshHost))) throw new Error('Invalid SSH host');
    const local = path.resolve(node.localWorkDir || path.join(BASE_TAKT_DIR, node.localWorkAlias || node.id));
    const mirrorKey = process.platform === 'win32' ? local.toLowerCase() : local;
    if (paths.has(mirrorKey)) throw new Error('Each node must have a separate local mirror');
    for (const key of ['syncthingTunnelPort', 'desktopWebPort', 'desktopVncPort']) {
      if (node[key] !== undefined && (!Number.isInteger(Number(node[key])) || Number(node[key]) < 1 || Number(node[key]) > 65535)) throw new Error(`Invalid ${key}`);
    }
    ids.add(node.id); paths.add(mirrorKey);
  }
}
function loadNodes() {
  const nodes = readNodes();
  for (const node of nodes) ensureNodeLocalDirAndSymlink(node);
  if (!fs.existsSync(NODES_FILE)) saveNodes(nodes);
  return nodes;
}
function saveNodes(nodes) {
  validateNodes(nodes);
  for (const node of nodes) ensureNodeLocalDirAndSymlink(node);
  const temp = NODES_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ nodes }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, NODES_FILE);
}

function getNodeById(nodeId) {
  const nodes = loadNodes();
  if (!nodeId) return nodes[0];
  const found = nodes.find((n) => n.id === nodeId || n.sshHost === nodeId || n.localWorkAlias === nodeId);
  if (!found) throw new Error(`Unknown node: ${nodeId}`);
  return found;
}

function discoverSshConfigHosts() {
  const out = [];
  const seen = new Set();
  try {
    const cfgPath = path.join(os.homedir(), '.ssh/config');
    if (fs.existsSync(cfgPath)) {
      const content = fs.readFileSync(cfgPath, 'utf8');
      let currentHosts = [];
      let hostName = '';
      let user = 'root';
      const flush = () => {
        for (const h of currentHosts) {
          if (!h || h.includes('*') || h.includes('?') || seen.has(h)) continue;
          seen.add(h);
          out.push({ alias: h, hostName: hostName || h, user: user || 'root' });
        }
      };
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const mHost = line.match(/^Host\s+(.+)$/i);
        if (mHost) {
          flush();
          currentHosts = mHost[1].trim().split(/\s+/);
          hostName = '';
          user = 'root';
          continue;
        }
        const mHn = line.match(/^HostName\s+(\S+)/i);
        if (mHn) hostName = mHn[1];
        const mUser = line.match(/^User\s+(\S+)/i);
        if (mUser) user = mUser[1];
      }
      flush();
    }
  } catch {}
  return out;
}


return { loadNodes, readNodes, saveNodes, getNodeById, ensureNodeLocalDirAndSymlink, discoverSshConfigHosts, validateNodes };
};
