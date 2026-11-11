#!/usr/bin/env node
/**
 * TAKT AI — Multi-Linux Node SSH Terminal Workbench Server
 * ---------------------------------------------------------------------
 * 1. Multi-Linux Node Registry ($TAKT_HOME/nodes.json):
 *    Each Linux server maps to its own isolated Mac local folder (work, work2, work3...),
 *    its own Syncthing folder, and its own dedicated MCP Reverse SSH Tunnel (-R 18765 & -R 49620)
 *    so EVERY Linux server can invoke the Mac's 21 MCP tools (Blender, FreeCAD, 嘉立创EDA, Xcode, Browser).
 * 2. Left Sidebar API: Passively scans all configured Linux servers & local work directories
 *    without touching the `claude` CLI binary, tagging every project and session with its Linux node badge.
 * 3. Center Multi-Tab Terminal WS: Each open conversation tab maps 1:1 to a persistent
 *    SSH + remote `tmux` session on that project's target Linux server.
 * 4. Right Sidebar File Browser & Preview API: Reads 100% from the Mac local filesystem
 *    corresponding to the active project's node (`work`, `work2`, `work3`...).
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { spawnTerminal } = require('../lib/pty-session');
const platform = require('../lib/platform');
const { mapper } = require('../lib/workspace-paths');
const { WebSocketServer } = require('ws');

const cfg = require('../config');
const { isLoopbackHost, isLocalOrigin, hasBearerToken } = require('../lib/http-security');
const { nodeTunnelSock } = require('../lib/tunnel-config');
const PORT = cfg.PORT;
const BASE_TAKT_DIR = cfg.TAKT_HOME;
const WORKSPACE_LINK_DIR = cfg.WORKSPACE_LINK_DIR;
const WORKBENCH_DB_FILE = cfg.DB_FILE;
const LOCAL_WORK_DIR = cfg.DEFAULT_WORK_DIR;
const DSH_WEB_LOG = path.join(cfg.LOG_DIR, 'workbench-web.log');
const MCP_URL = `http://127.0.0.1:${cfg.MCP_PORT}`;
const MCP_TOKEN = cfg.getMcpToken();
function mcpFetch(endpoint, options = {}) {
  return fetch(MCP_URL + endpoint, { ...options, headers: { ...options.headers, Authorization: `Bearer ${MCP_TOKEN}` } });
}
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');

fs.mkdirSync(LOCAL_WORK_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DSH_WEB_LOG), { recursive: true });

// Local-only guard helpers (see SECURITY.md): loopback Host blocks DNS rebinding,
// same-origin check blocks cross-site requests from web pages.
const isSameLocalOrigin = (origin) => isLocalOrigin(origin, PORT);

function shSingleQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function runCmd(cmd, args, timeoutMs = 8000, options = {}) {
  const isBgSsh = cmd === 'ssh' && Array.isArray(args) && args.includes('-Nf');
  const spec = platform.commandSpec(cmd, args);
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      env: platform.childEnv(), windowsHide: true,
      stdio: isBgSsh ? 'ignore' : [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(options.input); }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

// ============================================================================
// 0. Multi-Linux Node Registry & Auto-Provisioning (work, work2, work3...)
// ============================================================================
const nodeRegistry = require('../lib/node-registry')(cfg);
const { loadNodes, saveNodes, getNodeById, ensureNodeLocalDirAndSymlink, discoverSshConfigHosts, validateNodes } = nodeRegistry;

const provisionLinuxNode = require('./services/node-provisioner')({ cfg, runCmd, ensureNodeLocalDirAndSymlink, MCP_TOKEN });

// Ensure Mac Industrial MCP Daemon (:18765) stays running in background
let mcpSupervisorBusy = false;
async function ensureMacMcpDaemonRunning() {
  if (!cfg.SUPERVISE_MCP || process.env.TAKT_MANAGED_SERVICES === '1' || mcpSupervisorBusy) return;
  mcpSupervisorBusy = true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1800);
    let ok = false;
    try {
      const res = await mcpFetch('/system-status', { signal: ctrl.signal });
      if (res.ok) {
        const st = await res.json();
        ok = true;
        if (st && st.mcpStatus && !st.mcpStatus.remoteTunnelOk && !st.healing) {
          mcpFetch('/system-heal', { method: 'POST' }).catch(() => {});
        }
      }
    } catch {}
    clearTimeout(timer);

    if (!ok) {
      const mcpChild = spawn(process.execPath, [path.join(cfg.REPO_ROOT, 'mcp-server/server.js'), '--http'], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: platform.childEnv(),
      });
      mcpChild.unref();
    }
  } catch {} finally {
    mcpSupervisorBusy = false;
  }
}

setInterval(() => {
  ensureMacMcpDaemonRunning().catch(() => {});
}, 5000);
ensureMacMcpDaemonRunning().catch(() => {});

// ============================================================================
// 1. Passive Multi-Node Project & Session Scanner (NEVER touches `claude` CLI)
// ============================================================================

// ============================================================================
// 1b. Mac Local SQLite State Store ($TAKT_HOME/takt-workbench.sqlite)
//     Maintains projects & sessions locally so UI never flickers or loses items
//     when SSH polls time out or are in-flight.
// ============================================================================
const database = require('./repositories/workbench-db')(WORKBENCH_DB_FILE);
const { workbenchDb, readTagsFromSqlite, stmtUpsertProject, stmtUpsertSessionFromScan, stmtRegisterLocalSession, stmtRenameSession, stmtSoftDeleteSession, stmtUpsertNodeStatus } = database;

const sessionIndex = require('./services/session-index')({ cfg, database, nodeRegistry, runCmd });
const { loadCustomSessionTitles, saveCustomSessionTitle, normalizeToTopProjectPath, upsertProjectInSqlite, isPlaceholderSessionTitle, registerSessionInSqlite, syncAllNodesToSqlite, readTreeFromSqlite } = sessionIndex;

// Background SQLite sync daemon (every 10 seconds, non-blocking)
setInterval(() => {
  syncAllNodesToSqlite().catch(() => {});
}, 10000);
syncAllNodesToSqlite().catch(() => {});

// ============================================================================
// 2. Persistent Multi-Tab SSH Terminal Sessions (node-pty)
// ============================================================================
const activePtyTabs = new Map();

function getOrCreatePtyTab({ tabId, sessionId, title, cwd, resume, mode, nodeId, sshHost }) {
  if (activePtyTabs.has(tabId)) {
    const existing = activePtyTabs.get(tabId);
    if (nodeId && existing.nodeId !== nodeId) throw new Error('Terminal belongs to another node');
    if (!existing.exited) {
      if (title && title !== existing.title) existing.title = title;
      return existing;
    }
    activePtyTabs.delete(tabId);
  }

  const node = getNodeById(nodeId || sshHost);
  const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  const targetCwd = (cwd && String(cwd).startsWith('/')) ? String(cwd) : remoteRoot;
  const targetSshHost = node.sshHost || '';
  if (!targetSshHost || !node.enabled) throw new Error('Configure and enable the SSH node before opening a terminal');
  if (sshHost && sshHost !== targetSshHost) throw new Error('SSH host does not match the selected node');
  const sid = sessionId || crypto.randomUUID();
  const isShell = mode === 'shell';
  registerSessionInSqlite({ id: sid, nodeId: node.id, cwd: targetCwd, title });

  const launcherScript = path.join(__dirname, 'native-ssh-session.sh');
  const ptyProc = spawnTerminal(platform.isWindows ? process.execPath : '/bin/bash', [platform.isWindows ? path.join(cfg.REPO_ROOT, 'scripts/ssh-session.js') : launcherScript, String(tabId), targetCwd, targetSshHost], {
    name: 'xterm-256color',
    cols: 120,
    rows: 36,
    cwd: node.localWorkDir || LOCAL_WORK_DIR,
    env: platform.childEnv({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
    }),
  });

  const tabObj = {
    tabId,
    sessionId: sid,
    title: title || (isShell ? `终端 (${path.basename(targetCwd)})` : `对话 ${sid.slice(0, 8)}`),
    cwd: targetCwd,
    nodeId: node.id,
    nodeName: node.name,
    nodeBadge: node.badge,
    sshHost: targetSshHost,
    localWorkDir: node.localWorkDir,
    localWorkAlias: node.localWorkAlias,
    mode: isShell ? 'shell' : 'claude',
    createdAt: Date.now(),
    ptyProc,
    clients: new Set(),
    scrollback: [],
    scrollbackBytes: 0,
    exited: false,
    exitCode: null,
  };

  const MAX_SCROLLBACK_BYTES = 256 * 1024;

  ptyProc.onData((chunk) => {
    tabObj.scrollback.push(chunk);
    tabObj.scrollbackBytes += Buffer.byteLength(chunk, 'utf8');
    while (tabObj.scrollbackBytes > MAX_SCROLLBACK_BYTES && tabObj.scrollback.length > 1) {
      const removed = tabObj.scrollback.shift();
      tabObj.scrollbackBytes -= Buffer.byteLength(removed, 'utf8');
    }

    const msg = JSON.stringify({ type: 'output', tabId, data: chunk });
    for (const ws of tabObj.clients) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch {}
      }
    }
  });

  ptyProc.onExit(({ exitCode, signal }) => {
    tabObj.exited = true;
    tabObj.exitCode = exitCode;
    const msg = JSON.stringify({ type: 'exit', tabId, exitCode, signal });
    for (const ws of tabObj.clients) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch {}
      }
    }
    activePtyTabs.delete(tabId);
  });

  activePtyTabs.set(tabId, tabObj);
  return tabObj;
}

function sanitizeTmuxSessionId(tabId) {
  const safe = String(tabId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28) || 'main';
  return `takt_${safe}`;
}

function closePtyTab(tabId, explicitNodeId) {
  const candidate = activePtyTabs.get(tabId);
  const tab = candidate && (!explicitNodeId || candidate.nodeId === explicitNodeId) ? candidate : null;
  const node = getNodeById(explicitNodeId || (tab && tab.nodeId));
  const targetHost = (tab && tab.sshHost) || (node && node.sshHost) || '';
  const tmuxSess = sanitizeTmuxSessionId(tabId);
  docktermTabs.delete(`${targetHost}::${tmuxSess}`);
  if (targetHost) {
    runCmd('ssh', [
      '-o', 'ConnectTimeout=3',
      '-o', 'ClearAllForwardings=yes',
      targetHost,
      `tmux kill-session -t ${shSingleQuote(tmuxSess)} >/dev/null 2>&1 || true`,
    ], 4000).catch(() => {});
  }

  if (!tab) return false;
  activePtyTabs.delete(tabId);
  try {
    tab.ptyProc.kill();
  } catch {}
  for (const ws of tab.clients) {
    try { ws.close(); } catch {}
  }
  tab.clients.clear();
  return true;
}

// ============================================================================
// 3. Multi-Node Session File Browser & Preview Helpers (Mac Local Path Priority)
// ============================================================================
function workspaceMapper() { return mapper(loadNodes(), LOCAL_WORK_DIR, WORKSPACE_LINK_DIR); }
function inferNodeFromPathOrId(inputPath = '', nodeId = '') {
  return workspaceMapper().nodeFor(String(inputPath || ''), nodeId);
}
function mapRemoteCwdToLocal(remoteCwd = '/root/work', nodeId = '') {
  return workspaceMapper().toLocal(remoteCwd, nodeId);
}
function mapAnyCwdToRemote(inputCwd = '/root/work', nodeId = '') {
  return workspaceMapper().resolve(inputCwd, '/root/work', nodeId).remotePath;
}
function cwdMapsToLocal(cwd, node) {
  return Boolean(workspaceMapper().resolve(cwd, node.remoteWorkDir, node.id).localPath);
}
function resolveAnyFilePathToLocalAndRemote(inputPath, sessionCwd = '/root/work', nodeId = '') {
  const result = workspaceMapper().resolve(inputPath, sessionCwd, nodeId);
  // Host home files remain available for local previews, as on macOS.
  const raw = String(inputPath || '').replace(/^['"`]+|['"`]+$/g, '').replace(/:\d+(?::\d+)?$/, '');
  if (!result.localPath && path.isAbsolute(raw) && platform.contains(cfg.HOME, raw)) {
    result.localPath = path.resolve(raw);
  }
  return result;
}

// ---- Shared recursive directory watchers for the live file tree (one fs.watch per root, ref-counted) ----
const FILE_WATCH_IGNORE = /(^|[\\/])(\.git|node_modules|__pycache__|\.DS_Store|\.stfolder|\.stversions|dist|build|\.next|\.st[^\\/]*)([\\/]|$)/;
const fileWatchers = new Map(); // localRoot -> { watcher, subs:Set<fn>, timer }
function subscribeFileChanges(localRoot, cb) {
  if (!localRoot) return null;
  let entry = fileWatchers.get(localRoot);
  if (!entry) {
    let watcher;
    try {
      entry = { watcher: null, subs: new Set(), timer: null };
      const fire = () => {
        if (entry.timer) return;
        entry.timer = setTimeout(() => { entry.timer = null; entry.subs.forEach((fn) => { try { fn(); } catch {} }); }, 250);
      };
      watcher = fs.watch(localRoot, { recursive: true }, (_evt, filename) => {
        if (filename && FILE_WATCH_IGNORE.test(String(filename))) return;
        fire();
      });
      watcher.on('error', () => {});
      entry.watcher = watcher;
    } catch {
      return null;
    }
    fileWatchers.set(localRoot, entry);
  }
  entry.subs.add(cb);
  return () => {
    entry.subs.delete(cb);
    if (entry.subs.size === 0) {
      try { entry.watcher.close(); } catch {}
      if (entry.timer) clearTimeout(entry.timer);
      if (fileWatchers.get(localRoot) === entry) fileWatchers.delete(localRoot);
    }
  };
}

async function buildFileTree(localRoot, remoteRoot, node, maxDepth = 4) {
  const IGNORE = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.stfolder', '.stversions', 'dist', 'build', '.next']);
  const localBase = (node && node.localWorkDir) || LOCAL_WORK_DIR;
  const remoteBase = ((node && node.remoteWorkDir) || '/root/work').replace(/\/+$/, '') || '/root/work';

  async function walkLocal(dir, depth) {
    if (depth > maxDepth) return [];
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const items = [];
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith('.st')) continue;
      const fullLocal = path.join(dir, e.name);
      const relFromWork = path.relative(localBase, fullLocal).split(path.sep).join('/');
      const fullRemote = relFromWork ? `${remoteBase}/${relFromWork}` : remoteBase;
      const relFromProject = path.relative(localRoot, fullLocal).split(path.sep).join('/');

      try {
        const st = await fsp.stat(fullLocal);
        if (e.isDirectory()) {
          const children = await walkLocal(fullLocal, depth + 1);
          items.push({
            name: e.name,
            type: 'dir',
            path: fullLocal,
            localPath: fullLocal,
            remotePath: fullRemote,
            relPath: relFromProject,
            mtime: Math.round(st.mtimeMs),
            children,
          });
        } else if (e.isFile()) {
          items.push({
            name: e.name,
            type: 'file',
            path: fullLocal,
            localPath: fullLocal,
            remotePath: fullRemote,
            relPath: relFromProject,
            size: st.size,
            mtime: Math.round(st.mtimeMs),
            ext: path.extname(e.name).toLowerCase(),
          });
        }
      } catch {}
    }
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return items;
  }

  try {
    await fsp.mkdir(localRoot, { recursive: true });
  } catch {}
  const tree = await walkLocal(localRoot, 1);
  return {
    ok: true,
    nodeId: node.id,
    nodeBadge: node.badge,
    nodeName: node.name,
    localWorkAlias: node.localWorkAlias,
    root: localRoot,
    localRoot,
    remoteRoot: mapAnyCwdToRemote(remoteRoot, node.id),
    items: tree,
    source: platform.isWindows ? 'windows-local' : 'mac-local',
  };
}

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.stl': 'model/stl',
  '.obj': 'text/plain; charset=utf-8',
};

// ============================================================================
// 4. Bottom Status Bar Aggregator (Multi-Node SSH + Tailscale + MCP + Syncthing)
// ============================================================================
async function getCombinedSystemStatus() {
  let mcpData = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await mcpFetch('/system-status', { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      mcpData = await res.json();
    }
  } catch {}

  let localTailscaleOk = false;
  let localTailscaleIp = '';
  try {
    const tsBin = platform.isWindows ? platform.findProgram('TAKT_TAILSCALE_BIN', [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale/tailscale.exe')], 'tailscale.exe') : fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
      ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
      : 'tailscale';
    const tsRes = await runCmd(tsBin, ['ip', '-4'], 1500);
    const candidate = (tsRes.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^100\.\d+\.\d+\.\d+$/.test(l));
    if (candidate) {
      localTailscaleOk = true;
      localTailscaleIp = candidate;
    } else if (!platform.isWindows) {
      const ifRes = await runCmd('/sbin/ifconfig', [], 1500);
      const m = (ifRes.stdout || '').match(/inet\s+(100\.\d+\.\d+\.\d+)\s+-->/);
      if (m) {
        localTailscaleOk = true;
        localTailscaleIp = m[1];
      }
    }
  } catch {}

  const nodesStatus = mcpData?.nodesStatus || {};
  const nodeEntries = Object.values(nodesStatus);
  const onlineNodeEntries = nodeEntries.filter((n) => n && n.online);
  const anyNodeOnline = onlineNodeEntries.length > 0 || Boolean(mcpData?.remoteCli?.online);
  const anyMcpOk = nodeEntries.some((n) => n && n.mcpOk) || Boolean(mcpData?.mcpStatus?.ok);
  const totalCliProcs = nodeEntries.reduce((acc, n) => acc + Number(n?.processCount || 0), 0) || (mcpData?.remoteCli?.processCount ?? activePtyTabs.size);
  const bestPing = onlineNodeEntries.length > 0
    ? Math.min(...onlineNodeEntries.map((n) => Number(n.pingMs || 999)))
    : (mcpData?.mcpStatus?.pingMs || null);
  const activeHostSummary = onlineNodeEntries.length > 0
    ? onlineNodeEntries.map((n) => n.sshHost).join('+')
    : cfg.PRIMARY_NODE_ID;
  const egressIp = onlineNodeEntries[0]?.egressIp || mcpData?.remoteCli?.egressIp || '210.121.44.96';
  const remoteTailscaleOk = Boolean(mcpData?.remoteCli?.tailscaleOk);
  const remoteTailscaleIp = mcpData?.remoteCli?.tailscaleIp || '';

  return {
    ok: true,
    ssh: {
      online: anyNodeOnline,
      host: activeHostSummary,
      ingressIp: '210.126.238.129',
      egressIp,
      egressLocked: egressIp === '210.121.44.96',
      pingMs: bestPing,
      remoteCliProcesses: totalCliProcs,
      activeWorkbenchTabs: activePtyTabs.size,
      onlineNodesCount: onlineNodeEntries.length,
      totalNodesCount: nodeEntries.length || 1,
    },
    nodesStatus,
    tailscale: {
      ok: remoteTailscaleOk || localTailscaleOk,
      remoteDaemonActive: remoteTailscaleOk,
      remoteIp: remoteTailscaleIp,
      localIp: localTailscaleIp,
    },
    mcp: {
      ok: anyMcpOk,
      localHttpOk: Boolean(mcpData?.mcpStatus?.localMcpOk),
      remoteTunnelOk: anyMcpOk || Boolean(mcpData?.mcpStatus?.remoteTunnelOk),
      edaBridgeOk: Boolean(mcpData?.mcpStatus?.edaBridgeOk),
      tools: mcpData?.mcpStatus?.tools || 23,
    },
    syncthing: {
      ok: Boolean(mcpData?.diskSync?.connected) || (mcpData?.diskSync?.inSyncFiles > 0),
      connected: Boolean(mcpData?.diskSync?.connected),
      state: mcpData?.diskSync?.state || 'idle',
      inSyncFiles: mcpData?.diskSync?.inSyncFiles || 0,
      globalFiles: mcpData?.diskSync?.globalFiles || 0,
      needFiles: mcpData?.diskSync?.needFiles || 0,
      needBytes: mcpData?.diskSync?.needBytes || 0,
    },
    healing: Boolean(mcpData?.healing),
    timestamp: Date.now(),
  };
}

// ============================================================================
// 4B. DockTerm Chat Mode — incremental transcript reader + tmux screen inspector
//
// Each poll runs one small Python script on the node (over a ControlMaster socket) that
//   1. captures the *visible* tmux pane (status / permission prompt detection),
//   2. finds the Claude process running in that pane (its cwd + session id flags),
//   3. resolves the transcript `.jsonl` that process is writing, and
//   4. returns only the bytes appended since the last poll, pre-compacted to the
//      fields the chat view needs (tool results, images and file bodies are dropped).
// The server keeps the parsed rows per transcript and hands the browser deltas
// (`epoch` + `ver`), so a long conversation is transferred once, not every second.
// Older history is paged in on demand via /api/chat-history.
// ============================================================================
const DOCKTERM_NOISE_TAGS = [
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'system-reminder',
  'bash-stdout',
  'bash-stderr',
];
const DOCKTERM_NOISE_RE = new RegExp(`<(${DOCKTERM_NOISE_TAGS.join('|')})>[\\s\\S]*?<\\/\\1>`, 'g');

const DOCKTERM_INITIAL_BYTES = 2 * 1024 * 1024; // first load: last ~2 MB of the transcript
const DOCKTERM_HISTORY_BYTES = 2 * 1024 * 1024; // each "load earlier" page
const DOCKTERM_POLL_MAX_BYTES = 8 * 1024 * 1024; // cap per incremental poll
const DOCKTERM_MAX_TEXT = 40000; // per text block, applied on the node before transfer

function stripDocktermNoise(s) {
  return String(s || '')
    .replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, (_, cmd) => `! ${cmd.trim()}`)
    .replace(DOCKTERM_NOISE_RE, '')
    .replace(/\[Request interrupted by user[^\]]*\]/g, '')
    .trim();
}

function docktermBasename(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function docktermTrim(v, max) {
  if (typeof v !== 'string') return '';
  const one = v.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function summarizeDocktermTool(name, input) {
  const inp = (input && typeof input === 'object') ? input : {};
  switch (name) {
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'MultiEdit':
    case 'NotebookEdit':
      return docktermBasename(inp.file_path ?? inp.notebook_path);
    case 'Bash':
      return docktermTrim(inp.command, 120) || docktermTrim(inp.description, 120);
    case 'Grep':
    case 'Glob':
      return docktermTrim(inp.pattern, 80);
    case 'Task':
    case 'Agent':
      return docktermTrim(inp.description ?? inp.prompt, 100);
    case 'WebFetch': {
      const u = typeof inp.url === 'string' ? inp.url : '';
      try { return new URL(u).hostname; } catch { return docktermTrim(u, 80); }
    }
    case 'WebSearch':
      return docktermTrim(inp.query, 80);
    case 'TodoWrite': {
      const n = Array.isArray(inp.todos) ? inp.todos.length : Number(inp.todos || 0);
      return n ? `${n} item${n === 1 ? '' : 's'}` : '';
    }
    default:
      return docktermTrim(
        inp.file_path ?? inp.path ?? inp.command ?? inp.pattern ?? inp.query ?? inp.description ?? inp.url,
        80
      );
  }
}

/**
 * Turn compacted transcript records into chat rows.
 * `ctx` carries state across chunks: toolById (tool_use rows awaiting a result),
 * orphanResults (results whose tool_use lives in a chunk not loaded yet), lastUserText (dedupe).
 */
function parseTranscriptRecords(records, ctx, idPrefix) {
  const out = [];
  const setToolResult = (toolUseId, ok, images) => {
    const hit = ctx.toolById.get(toolUseId);
    if (!hit) {
      ctx.orphanResults.set(toolUseId, { ok, images });
      return;
    }
    let changed = false;
    if (hit.tool.ok !== ok) {
      hit.tool.ok = ok;
      changed = true;
    }
    if (images && images.length && !hit.tool.images) {
      hit.tool.images = images;
      changed = true;
    }
    if (changed && ctx.onToolUpdate) ctx.onToolUpdate(hit);
  };
  // Inline images stay on the node; rows carry a reference the UI resolves via /api/chat-image
  const imageRefs = (blocks, uuid) => (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && b.type === 'image' && Number.isInteger(b.off) && Number.isInteger(b.idx))
    .map((b) => ({ off: b.off, idx: b.idx, mt: typeof b.mt === 'string' ? b.mt : 'image/png', u: uuid || '' }));

  for (let i = 0; i < records.length; i++) {
    const obj = records[i];
    if (!obj || typeof obj !== 'object') continue;
    const t = obj.type;
    if (t !== 'user' && t !== 'assistant') continue;
    const content = obj.message && obj.message.content;
    const rawTs = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const ts = Number.isFinite(rawTs) ? rawTs : 0;
    const baseId = typeof obj.uuid === 'string' && obj.uuid ? obj.uuid : `${idPrefix}:${i}`;

    if (t === 'user') {
      const textParts = [];
      if (typeof content === 'string') {
        const clean = stripDocktermNoise(content);
        if (clean) textParts.push(clean);
      }
      let images = [];
      let unreadable = 0;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            setToolResult(b.tool_use_id, !b.is_error, imageRefs(b.images, obj.uuid));
          } else if (b.type === 'text' && typeof b.text === 'string') {
            const clean = stripDocktermNoise(b.text);
            if (clean) textParts.push(clean);
          } else if (b.type === 'image' && !Number.isInteger(b.off)) {
            unreadable += 1;
          }
        }
        images = imageRefs(content, obj.uuid);
        if (unreadable > 0) textParts.push(unreadable === 1 ? '[图片]' : `[图片 ×${unreadable}]`);
      }
      if (textParts.length > 0 || images.length > 0) {
        const joined = textParts.join('\n\n');
        if (images.length || joined !== ctx.lastUserText) {
          const row = { id: baseId, role: 'user', ts, text: joined };
          if (images.length) row.images = images.slice(0, 12);
          out.push(row);
          ctx.lastUserText = joined;
        }
      }
      continue;
    }

    if (Array.isArray(content)) {
      const textParts = [];
      let sub = 0;
      const flushText = () => {
        if (!textParts.length) return;
        out.push({ id: `${baseId}:${sub++}`, role: 'assistant', ts, text: textParts.join('\n\n') });
        textParts.length = 0;
        ctx.lastUserText = null;
      };
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string') {
          const clean = stripDocktermNoise(b.text);
          if (clean && clean !== 'No response requested.') textParts.push(clean);
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          flushText();
          const toolId = typeof b.id === 'string' && b.id ? b.id : `${baseId}:tool-${sub++}`;
          const row = {
            id: toolId,
            role: 'tool',
            ts,
            tool: { name: b.name, summary: summarizeDocktermTool(b.name, b.input), ok: null },
          };
          const inp = b.input && typeof b.input === 'object' ? b.input : {};
          const filePath = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : '';
          if (filePath) row.tool.path = filePath;
          if (ctx.orphanResults.has(toolId)) {
            const res = ctx.orphanResults.get(toolId);
            row.tool.ok = res.ok;
            if (res.images && res.images.length) row.tool.images = res.images;
            ctx.orphanResults.delete(toolId);
          }
          out.push(row);
          ctx.toolById.set(toolId, row);
        }
      }
      flushText();
    } else if (typeof content === 'string') {
      const clean = stripDocktermNoise(content);
      if (clean && clean !== 'No response requested.') {
        out.push({ id: baseId, role: 'assistant', ts, text: clean });
        ctx.lastUserText = null;
      }
    }
  }
  return out;
}

function newTranscriptState(host, jsonlPath, startOffset) {
  return {
    host,
    path: jsonlPath,
    epoch: crypto.randomBytes(4).toString('hex'),
    startOffset,
    endOffset: startOffset,
    messages: [],
    byId: new Map(),
    toolById: new Map(),
    orphanResults: new Map(),
    lastUserText: null,
    model: '',
    effort: '',
    modelTs: 0,
    ver: 0,
    seqHead: 0,
    seqTail: 0,
    touchedAt: Date.now(),
    historyInflight: null,
  };
}

function appendTranscriptRecords(st, records, chunkStart) {
  const ctx = {
    toolById: st.toolById,
    orphanResults: st.orphanResults,
    lastUserText: st.lastUserText,
    onToolUpdate: (row) => { if (row.ver) row.ver = ++st.ver; },
  };
  const rows = parseTranscriptRecords(records, ctx, `o${chunkStart}`);
  st.lastUserText = ctx.lastUserText;
  // Model / effort actually used by the latest reply (reflects /model and /effort changes)
  for (const r of records) {
    if (r && r.type === 'assistant' && typeof r.model === 'string' && r.model) {
      st.model = r.model;
      if (typeof r.effort === 'string') st.effort = r.effort;
      const ts = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
      st.modelTs = Number.isFinite(ts) ? ts : Date.now();
    }
  }
  for (const r of rows) {
    if (st.byId.has(r.id)) continue;
    r.seq = ++st.seqTail;
    r.ver = ++st.ver;
    st.messages.push(r);
    st.byId.set(r.id, r);
  }
}

function prependTranscriptRecords(st, records, chunkStart) {
  const ctx = { toolById: new Map(), orphanResults: st.orphanResults, lastUserText: null };
  const rows = parseTranscriptRecords(records, ctx, `o${chunkStart}`).filter((r) => !st.byId.has(r.id));
  const base = st.seqHead - rows.length;
  rows.forEach((r, i) => {
    r.seq = base + i;
    r.ver = ++st.ver;
    st.byId.set(r.id, r);
  });
  st.seqHead = base;
  st.messages = rows.concat(st.messages);
  return rows;
}

// ---------------------------------------------------------------------------
// Screen classification (visible tmux pane only — scrollback would keep stale
// "esc to interrupt" / prompt text around and pin the status forever)
// ---------------------------------------------------------------------------
const CLAUDE_SPINNER_LINE_RE = /^\s*[·✢✳✶✻✽∗*]\s+\S[^\n]{0,80}…/;
const CLAUDE_NUMBERED_OPT_RE = /^\s*(❯)?\s*(\d+)\.\s*(?:\[(x| )\]\s*)?(.+?)\s*$/;
const CLAUDE_UNNUMBERED_OPT_RE = /^\s*(❯)\s+(?:\[(x| )\]\s*)?(.+?)\s*$/;
const CLAUDE_STEP_CHIP_RE = /[☐✔☒]\s+[^\s☐✔☒]+/g;
const CLAUDE_HINT_LINE_RE = /^(Enter to |↑\/↓|Tab\/Arrow|Esc to cancel)/i;

function stripAnsiCodes(str) {
  return String(str || '').replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g, '');
}

function isClaudeRuleLine(t) {
  return t.length >= 6 && /^[─━═╌╍┈┉\-]{6,}$/.test(t);
}

function isClaudeBoxEdge(t) {
  return /^[╭╰┌└][─━]/.test(t) || /[─━][╮╯┐┘]$/.test(t);
}

// Remove the "│ ... │" frame Claude Code draws around dialogs and the input box.
function unframeLine(line) {
  return String(line || '').replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '');
}

function isBinaryAllowDeny(options) {
  if (options.length < 2) return false;
  const first = options[0].toLowerCase();
  const last = options[options.length - 1].toLowerCase();
  if (!/^yes\b|^allow\b/.test(first) || !/^no\b|^deny\b/.test(last)) return false;
  return options.slice(1, -1).every((o) => /^yes\b|^allow\b/i.test(o));
}

function parseClaudeAsk(screenText) {
  const framedLines = screenText.split('\n');
  const rawLines = framedLines.map(unframeLine);
  let footerIdx = -1;
  for (let i = rawLines.length - 1; i >= 0; i--) {
    if (/esc to cancel/i.test(rawLines[i])) {
      footerIdx = i;
      break;
    }
  }
  const endIdx = footerIdx >= 0 ? footerIdx : rawLines.length;

  // Locate the dialog: the last "❯" cursor line, then walk up to the dialog's own frame
  // (outer "╭" box edge at the same indent, or a long solid rule) so that nested boxes
  // such as an Edit diff stay part of the prompt body.
  let cursorLine = -1;
  for (let i = endIdx - 1; i >= 0; i--) {
    if (/^\s*❯/.test(rawLines[i])) {
      cursorLine = i;
      break;
    }
  }
  let blockStart = 0;
  const anchor = cursorLine >= 0 ? cursorLine : endIdx - 1;
  const frame = anchor >= 0 ? (framedLines[anchor] || '').match(/^(\s*)│/) : null;
  for (let i = anchor - 1; i >= 0; i--) {
    const r = framedLines[i] || '';
    if (frame) {
      const ind = frame[1].length;
      if (r[ind] === '╭' && !r.slice(0, ind).trim()) {
        blockStart = i + 1;
        break;
      }
    } else if (/^\s*[─━]{20,}\s*$/.test(r)) {
      blockStart = i + 1;
      break;
    }
  }

  const parsed = [];
  let cursorPos = 0;
  for (let i = blockStart; i < endIdx; i++) {
    const nm = rawLines[i].match(CLAUDE_NUMBERED_OPT_RE);
    if (nm) {
      const n = Number(nm[2]);
      if (n === 1 && parsed.length > 0 && parsed[0].numbered) {
        parsed.length = 0; // a fresh list started — keep the latest one
        cursorPos = 0;
      }
      if (n === parsed.length + 1) {
        if (nm[1]) cursorPos = parsed.length;
        parsed.push({
          row: i,
          label: nm[4],
          numbered: true,
          check: nm[3] === 'x' ? true : nm[3] === ' ' ? false : null,
        });
      }
      continue;
    }
    const um = rawLines[i].match(CLAUDE_UNNUMBERED_OPT_RE);
    if (um && parsed.length === 0) {
      cursorPos = 0;
      parsed.push({ row: i, label: um[3], numbered: false, check: um[2] === 'x' ? true : um[2] === ' ' ? false : null });
      for (let j = i + 1; j < endIdx && parsed.length < 12; j++) {
        const raw = rawLines[j];
        const t = raw.trim();
        if (!t || isClaudeRuleLine(t) || isClaudeBoxEdge(t)) break;
        if (CLAUDE_HINT_LINE_RE.test(t)) break;
        const indent = (raw.match(/^\s*/) || [''])[0].length;
        if (indent < 2 || indent > 5) break;
        const cm = t.match(/^\[(x| )\]\s*(.+)$/);
        parsed.push({ row: j, label: cm ? cm[2] : t, numbered: false, check: cm ? cm[1] === 'x' : null });
      }
      break;
    }
  }

  let options = parsed.map((p) => p.label);
  const numbered = parsed.length > 0 ? parsed[0].numbered : true;
  let checkable = parsed.map((p) => p.check !== null);
  let checked = parsed.map((p) => p.check === true);

  let submitIndex = null;
  if (checkable.some(Boolean)) {
    for (let k = parsed.length - 1; k >= 0; k--) {
      if (!checkable[k] && /^(submit|done|continue|confirm|finish)\b/i.test(options[k])) {
        submitIndex = k;
        break;
      }
    }
    if (submitIndex === null) {
      const lastOptRow = parsed[parsed.length - 1].row;
      for (let r = lastOptRow + 1; r < endIdx; r++) {
        const t = rawLines[r].trim().replace(/^❯\s*/, '');
        if (!t || isClaudeRuleLine(t)) continue;
        if (/^(submit|done|continue|confirm|finish)\b/i.test(t) && t.length < 40) {
          if (/^\s*❯/.test(rawLines[r])) cursorPos = options.length;
          submitIndex = options.length;
          options.push(t);
          checkable.push(false);
          checked.push(false);
          parsed.push({ row: r, label: t, numbered: false, check: null });
          break;
        }
      }
    }
  }

  const descriptions = options.map((_, k) => {
    const start = parsed[k].row + 1;
    const stop = k + 1 < parsed.length ? parsed[k + 1].row : endIdx;
    const parts = [];
    for (let r = start; r < stop; r++) {
      const t = rawLines[r].trim();
      if (!t || isClaudeRuleLine(t) || isClaudeBoxEdge(t)) break;
      if (CLAUDE_HINT_LINE_RE.test(t)) break;
      parts.push(t);
    }
    return parts.join(' ');
  });

  if (options.length === 0) {
    options = ['Allow', 'Deny'];
    descriptions.push('', '');
    checkable = [false, false];
    checked = [false, false];
  }

  // Prompt body: everything above the options up to the dialog frame / rule line.
  const firstOptRow = parsed.length > 0 ? parsed[0].row : endIdx;
  let steps = [];
  const above = [];
  for (let i = firstOptRow - 1; i >= blockStart && above.length < 60; i--) {
    const t = rawLines[i].trimEnd();
    const tt = t.trim();
    if (!blockStart && (isClaudeRuleLine(tt) || isClaudeBoxEdge(tt))) break;
    if (/^[·✢✳✶✻✽●⏺]\s/.test(tt)) break;
    const chips = tt.match(CLAUDE_STEP_CHIP_RE);
    if (chips && chips.length >= 1 && (tt.includes('←') || tt.includes('→') || chips.length >= 2)) {
      steps = chips.map((c) => ({ done: c[0] === '✔' || c[0] === '☒', label: c.slice(1).trim() }));
      break;
    }
    above.unshift(t);
  }
  // Dedent and collapse blank runs
  const nonEmpty = above.filter((l) => l.trim());
  const minIndent = nonEmpty.length ? Math.min(...nonEmpty.map((l) => (l.match(/^\s*/) || [''])[0].length)) : 0;
  const bodyLines = [];
  for (const l of above) {
    const v = l.slice(minIndent);
    if (!v.trim() && (!bodyLines.length || !bodyLines[bodyLines.length - 1].trim())) continue;
    bodyLines.push(v);
  }
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
  const title = bodyLines.join('\n') || 'Claude 正在等待你的输入';
  const footer = footerIdx >= 0 ? rawLines.slice(Math.max(0, footerIdx - 1), footerIdx + 1).join(' ') : '';
  const multiSelect = checkable.some(Boolean) || /space to select/i.test(footer);
  const freeTextIndex = options.findIndex((o) => /^(type something|other\b|chat about this)/i.test(o));

  return {
    title,
    options,
    descriptions,
    steps,
    binary: !multiSelect && isBinaryAllowDeny(options),
    multiSelect,
    checkable,
    checked,
    submitIndex,
    freeTextIndex,
    cursorRow: cursorPos,
    numbered,
  };
}

function classifyClaudeScreen(rawScreen) {
  const clean = stripAnsiCodes(rawScreen);
  const lines = clean.split('\n').map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const lastLines = lines.filter((l) => l.trim()).slice(-14);
  const lastText = lastLines.join('\n');

  let status = 'idle';
  const asking = /\bEsc to cancel\b/i.test(lastText) || lastLines.some((l) => /^\s*❯\s*\d+\.\s+\S/.test(unframeLine(l)));
  if (asking) status = 'asking';
  else if (/\besc to interrupt\b/i.test(lastText) || lastLines.some((l) => CLAUDE_SPINNER_LINE_RE.test(l))) status = 'working';

  const ask = status === 'asking' ? parseClaudeAsk(lines.join('\n')) : null;

  // Live tail: last meaningful lines above Claude's input box / footer hints
  const tailLines = lines
    .map(unframeLine)
    .filter((l) => {
      const t = l.trim();
      if (!t || isClaudeRuleLine(t) || isClaudeBoxEdge(t)) return false;
      if (/^[>›❯](\s|$)/.test(t)) return false; // Claude's input line (may hold an unsent draft)
      if (/\? for shortcuts|shift\+tab|⏵⏵|bypass permissions|auto-accept edits|plan mode on/i.test(t)) return false;
      return true;
    })
    .slice(-8);

  return { status, ask, tail: tailLines.join('\n') };
}

// ---------------------------------------------------------------------------
// Remote inspector (Python 3, stdlib only). Config arrives base64-encoded.
// ---------------------------------------------------------------------------
const DOCKTERM_REMOTE_PY = String.raw`
import os, sys, json, glob, re, time, base64, subprocess

cfg = json.loads(base64.b64decode(CFG_B64).decode("utf-8"))
mode = cfg.get("mode", "poll")
home = os.path.expanduser("~")
proj_root = os.path.join(home, ".claude", "projects")
proj_root_real = os.path.realpath(proj_root)
MAX_TEXT = int(cfg.get("maxText", 40000))
KEEP_KEYS = ("file_path", "notebook_path", "path", "command", "description", "pattern", "prompt", "url", "query")
UUID_RE = re.compile(r"(?:--resume|--session-id|-r)[ =]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})")
CLAUDE_RE = re.compile(r"(^|/)claude(\s|$)|claude-code/cli|@anthropic-ai/claude")

def out(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()

def clip(s):
    return s if len(s) <= MAX_TEXT else s[:MAX_TEXT] + "\n…"

def img_ref(b, off, k):
    # Inline (base64) images stay on the node; the UI fetches them later by line offset + index
    src = b.get("source") if isinstance(b.get("source"), dict) else {}
    if src.get("type") == "base64" and isinstance(src.get("data"), str) and off is not None:
        return {"type": "image", "off": off, "idx": k, "mt": src.get("media_type") or "image/png"}
    return {"type": "image"}

def queued_prompt(obj):
    # A message typed while Claude works is usually handed over mid-turn: the transcript then has a
    # queued_command attachment instead of a user record (task notifications / subagent hand-backs excluded)
    a = obj.get("attachment") if isinstance(obj.get("attachment"), dict) else {}
    if a.get("type") != "queued_command" or a.get("commandMode", "prompt") != "prompt" or a.get("isMeta"):
        return None
    origin = a.get("origin") if isinstance(a.get("origin"), dict) else {}
    if origin.get("kind") != "human" and not a.get("humanTurn"):
        return None
    p = a.get("prompt")
    return p if isinstance(p, (str, list)) else None

def compact(obj, off=None):
    t = obj.get("type")
    if t == "attachment" and not obj.get("isSidechain"):
        p = queued_prompt(obj)
        if p is None:
            return None
        obj = {"type": "user", "uuid": obj.get("uuid"), "timestamp": obj.get("timestamp"), "message": {"content": p}}
        t = "user"
    if t not in ("user", "assistant"):
        return None
    if obj.get("isSidechain") or obj.get("isMeta") or obj.get("isCompactSummary") or obj.get("isVisibleInTranscriptOnly"):
        return None
    msg = obj.get("message")
    if not isinstance(msg, dict):
        return None
    c = msg.get("content")
    k = 0
    if isinstance(c, str):
        cc = clip(c)
    elif isinstance(c, list):
        cc = []
        for b in c:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text" and isinstance(b.get("text"), str):
                cc.append({"type": "text", "text": clip(b["text"])})
            elif bt == "tool_use":
                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                small = {}
                for key in KEEP_KEYS:
                    v = inp.get(key)
                    if isinstance(v, str):
                        small[key] = v[:400]
                if isinstance(inp.get("todos"), list):
                    small["todos"] = len(inp["todos"])
                cc.append({"type": "tool_use", "id": b.get("id"), "name": b.get("name"), "input": small})
            elif bt == "tool_result":
                r = {"type": "tool_result", "tool_use_id": b.get("tool_use_id"), "is_error": bool(b.get("is_error"))}
                inner = b.get("content")
                if isinstance(inner, list):
                    imgs = []
                    for ib in inner:
                        if isinstance(ib, dict) and ib.get("type") == "image":
                            imgs.append(img_ref(ib, off, k))
                            k += 1
                    if imgs:
                        r["images"] = imgs[:6]
                cc.append(r)
            elif bt == "image":
                cc.append(img_ref(b, off, k))
                k += 1
    else:
        return None
    rec = {"type": t, "uuid": obj.get("uuid"), "timestamp": obj.get("timestamp"), "message": {"content": cc}}
    if t == "assistant":
        model = msg.get("model")
        if isinstance(model, str) and model and not model.startswith("<"):
            rec["model"] = obj.get("requestedModel") if isinstance(obj.get("requestedModel"), str) else model
            if isinstance(obj.get("effort"), str):
                rec["effort"] = obj["effort"]
    return rec

def iter_images(content):
    # Same order as compact() numbers them
    found = []
    if isinstance(content, list):
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "image":
                found.append(b)
            elif b.get("type") == "tool_result" and isinstance(b.get("content"), list):
                for ib in b["content"]:
                    if isinstance(ib, dict) and ib.get("type") == "image":
                        found.append(ib)
    return found

def records_from(data, base=0):
    recs = []
    pos = 0
    n = len(data)
    while pos < n:
        nl = data.find(b"\n", pos)
        if nl < 0:
            nl = n
        line = data[pos:nl]
        off = base + pos
        pos = nl + 1
        if line[:1] != b"{":
            line = line.strip()
            if line[:1] != b"{":
                continue
            off = None
        try:
            obj = json.loads(line.decode("utf-8", "ignore"))
        except Exception:
            continue
        if isinstance(obj, dict):
            r = compact(obj, off)
            if r:
                recs.append(r)
    return recs

def next_line_start(f, pos):
    if pos <= 0:
        return 0
    f.seek(pos - 1)
    base = pos - 1
    while True:
        block = f.read(65536)
        if not block:
            return None
        i = block.find(b"\n")
        if i >= 0:
            return base + i + 1
        base += len(block)

def prev_line_start(f, pos):
    p = pos - 1
    while p > 0:
        step = min(65536, p)
        f.seek(p - step)
        block = f.read(step)
        i = block.rfind(b"\n")
        if i >= 0:
            return p - step + i + 1
        p -= step
    return 0

def read_lines(f, start, stop):
    f.seek(start)
    data = f.read(max(0, stop - start))
    i = data.rfind(b"\n")
    if i < 0:
        return b"", start
    return data[:i + 1], start + i + 1

def safe_jsonl(p):
    if not p:
        return ""
    real = os.path.realpath(p)
    if not real.startswith(proj_root_real + os.sep) or not real.endswith(".jsonl") or not os.path.isfile(real):
        return ""
    return real

# ---------------------------------------------------------------- history page
if mode == "history":
    fp = safe_jsonl(cfg.get("path", ""))
    before = int(cfg.get("before", 0))
    chunk = int(cfg.get("chunkBytes", 2097152))
    if not fp or before <= 0:
        out({"error": "no-transcript"})
        sys.exit(0)
    with open(fp, "rb") as f:
        start = 0 if before - chunk <= 0 else next_line_start(f, before - chunk)
        if start is None or start >= before:
            start = prev_line_start(f, before)
        data, _ = read_lines(f, start, before)
    out({"jsonlPath": fp, "chunkStart": start, "chunkEnd": before, "records": records_from(data, start)})
    sys.exit(0)

# ---------------------------------------------------------------- one inline image
if mode == "image":
    fp = safe_jsonl(cfg.get("path", ""))
    off = int(cfg.get("off", -1))
    idx = int(cfg.get("idx", -1))
    if not fp or off < 0 or idx < 0:
        out({"error": "bad-ref"})
        sys.exit(0)
    with open(fp, "rb") as f:
        f.seek(off)
        line = f.readline()
    try:
        obj = json.loads(line.decode("utf-8", "ignore"))
    except Exception:
        obj = None
    if not isinstance(obj, dict) or (cfg.get("uuid") and obj.get("uuid") != cfg.get("uuid")):
        out({"error": "moved"})
        sys.exit(0)
    msg = obj.get("message") if isinstance(obj.get("message"), dict) else {}
    imgs = iter_images(queued_prompt(obj) if obj.get("type") == "attachment" else msg.get("content"))
    src = imgs[idx].get("source") if idx < len(imgs) and isinstance(imgs[idx].get("source"), dict) else {}
    if src.get("type") != "base64" or not isinstance(src.get("data"), str):
        out({"error": "not-inline"})
        sys.exit(0)
    out({"mediaType": src.get("media_type") or "image/png", "data": src["data"]})
    sys.exit(0)

# ---------------------------------------------------------------- usage / models / settings
# The OAuth token never leaves the node: only the numbers / model ids are returned.
if mode == "meta":
    want = set(cfg.get("parts") or [])
    res = {}
    try:
        with open(os.path.join(home, ".claude", ".credentials.json")) as f:
            cred = (json.load(f) or {}).get("claudeAiOauth") or {}
    except Exception:
        cred = {}
    try:
        with open(os.path.join(home, ".claude.json")) as f:
            cj = json.load(f)
        if not isinstance(cj, dict):
            cj = {}
    except Exception:
        cj = {}
    tok = cred.get("accessToken") if isinstance(cred.get("accessToken"), str) else ""
    exp = cred.get("expiresAt") or 0
    live = bool(tok) and (not exp or exp / 1000.0 > time.time() + 30)
    res["plan"] = cred.get("subscriptionType") or ""

    def api_get(path_):
        import urllib.request
        req = urllib.request.Request("https://api.anthropic.com" + path_, headers={
            "Authorization": "Bearer " + tok,
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "User-Agent": "takt-workbench",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=6) as r:
            return json.loads(r.read().decode("utf-8"))

    if "usage" in want:
        u = None
        src = ""
        err = "" if live else ("no-oauth" if not tok else "token-expired")
        fetched = int(time.time() * 1000)
        if live:
            try:
                u = api_get("/api/oauth/usage")
                src = "live"
            except Exception as e:
                err = str(e)[:160]
        if not isinstance(u, dict):
            # Claude Code keeps its own last /usage result; better than nothing when offline
            cu = cj.get("cachedUsageUtilization") if isinstance(cj.get("cachedUsageUtilization"), dict) else {}
            if isinstance(cu.get("utilization"), dict):
                u = cu["utilization"]
                src = "cache"
                fetched = cu.get("fetchedAtMs") or 0
        def pick(key):
            v = u.get(key) if isinstance(u, dict) else None
            if isinstance(v, dict) and v.get("utilization") is not None:
                return {"pct": v.get("utilization"), "resetsAt": v.get("resets_at")}
            return None
        res["usage"] = {
            "fiveHour": pick("five_hour"),
            "week": pick("seven_day"),
            "weekOpus": pick("seven_day_opus"),
            "weekSonnet": pick("seven_day_sonnet"),
            "source": src,
            "fetchedAt": fetched,
        } if isinstance(u, dict) else None
        res["usageError"] = err

    if "models" in want:
        models = []
        if live:
            try:
                d = api_get("/v1/models?limit=100")
                for m in d.get("data") or []:
                    if not isinstance(m, dict) or not m.get("id"):
                        continue
                    eff = (m.get("capabilities") or {}).get("effort") or {}
                    levels = [lv for lv in ("low", "medium", "high", "xhigh", "max")
                              if eff.get("supported") and isinstance(eff.get(lv), dict) and eff[lv].get("supported")]
                    models.append({
                        "id": m["id"],
                        "name": m.get("display_name") or m["id"],
                        "line": m.get("line") or "",
                        "efforts": levels,
                        "deprecated": bool(m.get("deprecated_at")),
                    })
            except Exception as e:
                res["modelsError"] = str(e)[:160]
        else:
            res["modelsError"] = "no-oauth" if not tok else "token-expired"
        extra = cj.get("additionalModelOptionsCache")
        res["extraModels"] = [
            {"id": o.get("value"), "name": o.get("label") or o.get("value"), "description": o.get("description") or ""}
            for o in (extra if isinstance(extra, list) else []) if isinstance(o, dict) and isinstance(o.get("value"), str)
        ]
        res["models"] = models

    if "current" in want:
        merged = {}
        cwd_ = (cfg.get("cwd") or home).rstrip("/") or "/"
        for p in (os.path.join(home, ".claude", "settings.json"),
                  os.path.join(cwd_, ".claude", "settings.json"),
                  os.path.join(cwd_, ".claude", "settings.local.json")):
            try:
                with open(p) as f:
                    d = json.load(f)
            except Exception:
                continue
            if isinstance(d, dict):
                for key in ("model", "effortLevel", "modelSettings"):
                    if key in d:
                        merged[key] = d[key]
        res["settings"] = {
            "model": merged.get("model") if isinstance(merged.get("model"), str) else "",
            "effortLevel": merged.get("effortLevel") if isinstance(merged.get("effortLevel"), str) else "",
            "modelSettings": merged.get("modelSettings") if isinstance(merged.get("modelSettings"), dict) else {},
        }
    out(res)
    sys.exit(0)

# ---------------------------------------------------------------- poll
tmux_sess = cfg.get("tmuxSess", "")
tab_cwd = (cfg.get("cwd") or "").rstrip("/") or home
sid = (cfg.get("sessionId") or "").strip()
known_path = safe_jsonl(cfg.get("knownPath", ""))
known_end = int(cfg.get("knownEnd", 0))
claimed_paths = set(os.path.realpath(p) for p in (cfg.get("claimedPaths") or []) if p)

def run(args, timeout=2):
    try:
        r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else ""
    except Exception:
        return ""

pane_text = ""
pane_cwd = ""
pane_pid = 0
# "=name:" = exact session match (plain -t also accepts prefixes / fnmatch patterns)
target = "=" + tmux_sess + ":"
info = run(["tmux", "display-message", "-p", "-t", target, "#{pane_pid}\t#{pane_current_path}"]).strip()
if info:
    parts = info.split("\t")
    try:
        pane_pid = int(parts[0])
    except Exception:
        pane_pid = 0
    pane_cwd = parts[1] if len(parts) > 1 else ""
if pane_pid:
    pane_text = run(["tmux", "capture-pane", "-p", "-J", "-t", target])

# Process table -> the claude process inside this pane (+ ids claimed by other claude processes)
procs = {}
children = {}
for line in run(["ps", "-eo", "pid=,ppid=,etimes=,args="]).splitlines():
    p = line.strip().split(None, 3)
    if len(p) < 3:
        continue
    try:
        pid, ppid, et = int(p[0]), int(p[1]), int(p[2])
    except Exception:
        continue
    procs[pid] = (ppid, et, p[3] if len(p) > 3 else "")
    children.setdefault(ppid, []).append(pid)

claude_pid = 0
if pane_pid:
    queue = [pane_pid]
    seen = set()
    while queue and not claude_pid:
        cur = queue.pop(0)
        if cur in seen:
            continue
        seen.add(cur)
        pr = procs.get(cur)
        if pr and CLAUDE_RE.search(pr[2]):
            claude_pid = cur
            break
        queue.extend(children.get(cur, []))

claimed_by_others = set()
for pid, pr in procs.items():
    if pid != claude_pid and CLAUDE_RE.search(pr[2]):
        m = UUID_RE.search(pr[2])
        if m:
            claimed_by_others.add(m.group(1))

claude_running = bool(claude_pid)
claude_start = 0
claude_cwd = ""
hint_ids = []
launch_model = ""
launch_effort = ""
if claude_pid:
    ppid, et, args = procs[claude_pid]
    claude_start = time.time() - et
    try:
        claude_cwd = os.readlink("/proc/%d/cwd" % claude_pid)
    except Exception:
        claude_cwd = ""
    m = UUID_RE.search(args)
    if m:
        hint_ids.append(m.group(1))
    m = re.search(r"--model[ =](\S+)", args)
    launch_model = m.group(1) if m else ""
    m = re.search(r"--effort[ =](\S+)", args)
    launch_effort = m.group(1) if m else ""
elif pane_text and ("esc to interrupt" in pane_text.lower() or "? for shortcuts" in pane_text):
    claude_running = True
if sid and sid not in hint_ids:
    hint_ids.append(sid)

# Transcript resolution: Claude stores <cwd with every non-alphanumeric char -> '-'>/<session>.jsonl
def slug(p):
    return re.sub(r"[^a-zA-Z0-9]", "-", p)

cwd_opts = []
for c in (claude_cwd, pane_cwd, tab_cwd):
    if c and c not in cwd_opts:
        cwd_opts.append(c)
if tab_cwd.startswith("/root/") and home != "/root":
    cwd_opts.append(os.path.join(home, tab_cwd[6:]))
dirs = []
for c in cwd_opts:
    d = os.path.join(proj_root, slug(c.rstrip("/") or "/"))
    if os.path.isdir(d) and d not in dirs:
        dirs.append(d)

def mtime(p):
    try:
        return os.path.getmtime(p)
    except Exception:
        return 0

def first_ts(p):
    # timestamp of the first record = when that transcript was started
    try:
        with open(p, "rb") as f:
            head = f.read(65536)
        for line in head.split(b"\n"):
            try:
                ts = json.loads(line.decode("utf-8", "ignore")).get("timestamp")
            except Exception:
                continue
            if isinstance(ts, str) and len(ts) >= 19:
                import calendar
                return calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        pass
    return mtime(p)

def follow_clear(current, pool):
    # /clear starts a new transcript in the same process: switch only to a newer file that
    # began after the current one went quiet (files of other tabs are excluded from the pool)
    best = current
    for p in sorted(pool, key=mtime, reverse=True):
        if p == current or mtime(p) <= mtime(current):
            continue
        if first_ts(p) >= mtime(current) - 5:
            best = p
            break
    return best

hinted = ""
for hid in hint_ids:
    for d in dirs:
        p = os.path.join(d, hid + ".jsonl")
        if os.path.isfile(p):
            hinted = p
            break
    if not hinted:
        g = glob.glob(os.path.join(proj_root, "*", hid + ".jsonl"))
        if g:
            hinted = max(g, key=mtime)
    if hinted:
        break

chosen = ""
if claude_pid:
    window = claude_start - 5
    pool = []
    for d in dirs:
        for p in glob.glob(os.path.join(d, "*.jsonl")):
            if mtime(p) < window:
                continue
            if os.path.splitext(os.path.basename(p))[0] in claimed_by_others or os.path.realpath(p) in claimed_paths:
                continue
            pool.append(p)
    if hinted and mtime(hinted) >= window:
        chosen = follow_clear(hinted, pool)          # launched with --session-id / -r and writing it
    elif known_path and known_path in pool:
        chosen = follow_clear(known_path, pool)      # stick to what this tab showed before
    elif pool:
        chosen = max(pool, key=mtime)                # plain "claude": newest unclaimed transcript
    elif hinted:
        chosen = hinted                              # just resumed, nothing written yet
elif hinted:
    chosen = hinted
elif known_path:
    chosen = known_path
chosen = safe_jsonl(chosen)

res = {
    "claudeRunning": claude_running,
    "paneText": pane_text,
    "paneCwd": claude_cwd or pane_cwd,
    "tmuxAlive": bool(pane_pid),
    "jsonlPath": chosen,
    "resolvedSessionId": os.path.splitext(os.path.basename(chosen))[0] if chosen else "",
    "launchModel": launch_model,
    "launchEffort": launch_effort,
}
if chosen:
    size = os.path.getsize(chosen)
    with open(chosen, "rb") as f:
        if chosen == known_path and size >= known_end > 0:
            stop = min(size, known_end + int(cfg.get("maxBytes", 8388608)))
            data, end = read_lines(f, known_end, stop)
            if not data and size - known_end > int(cfg.get("maxBytes", 8388608)):
                nxt = next_line_start(f, known_end + 1)
                end = nxt if nxt is not None else known_end
            res.update({"reset": False, "chunkStart": known_end, "chunkEnd": end, "records": records_from(data, known_end)})
        else:
            initial = int(cfg.get("initialBytes", 2097152))
            start = 0 if size <= initial else next_line_start(f, size - initial)
            if start is None:
                start = prev_line_start(f, size)
            data, end = read_lines(f, start, size)
            res.update({"reset": True, "chunkStart": start, "chunkEnd": end, "records": records_from(data, start)})
    res["size"] = size
out(res)
`.trim();

function buildDocktermRemotePy(cfg) {
  const cfgB64 = Buffer.from(JSON.stringify({ maxText: DOCKTERM_MAX_TEXT, ...cfg }), 'utf8').toString('base64');
  return DOCKTERM_REMOTE_PY.replace('CFG_B64', JSON.stringify(cfgB64));
}

// One multiplexed SSH connection per node, shared by all DockTerm requests
const DOCKTERM_SSH_OPTS = [
  '-o', 'ConnectTimeout=4',
  '-o', 'BatchMode=yes',
  ...(!platform.isWindows ? ['-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/takt-chat-mux-%r@%h:%p', '-o', 'ControlPersist=120s'] : []),
  '-o', 'ClearAllForwardings=yes',
];

async function runDocktermRemotePy(host, cfg, timeoutMs) {
  const b64 = Buffer.from(buildDocktermRemotePy(cfg), 'utf8').toString('base64');
  const r = await runCmd('ssh', [
    ...DOCKTERM_SSH_OPTS,
    host,
    `python3 -c "import base64;exec(base64.b64decode('${b64}'))"`,
  ], timeoutMs);
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    return null;
  }
}

const docktermTabs = new Map(); // `${host}::${tmuxSess}` -> per-tab resolution + last screen
const docktermTranscripts = new Map(); // `${host}::${jsonlPath}` -> parsed transcript state
let docktermLastSweep = Date.now();

function sweepDocktermCaches() {
  const now = Date.now();
  if (now - docktermLastSweep < 5 * 60 * 1000) return;
  docktermLastSweep = now;
  for (const [k, st] of docktermTranscripts) {
    if (now - st.touchedAt > 30 * 60 * 1000) docktermTranscripts.delete(k);
  }
  for (const [k, t] of docktermTabs) {
    if (now - (t.touchedAt || 0) > 30 * 60 * 1000) docktermTabs.delete(k);
  }
}

function resolveDocktermTarget({ tabId, sessionId, nodeId, sshHost }) {
  const node = getNodeById(nodeId || sshHost);
  const host = sshHost || (node && node.sshHost) || '';
  const tmuxSess = sanitizeTmuxSessionId(tabId || sessionId || 'default');
  const key = `${host}::${tmuxSess}`;
  let tab = docktermTabs.get(key);
  if (!tab) {
    tab = { host, tmuxSess, path: '', screen: null, claudeRunning: false, resolvedSessionId: '', stale: false, inflight: null, touchedAt: Date.now() };
    docktermTabs.set(key, tab);
  }
  tab.touchedAt = Date.now();
  return tab;
}

async function refreshDocktermTab(tab, { tabId, sessionId, cwd }) {
  const known = tab.path ? docktermTranscripts.get(`${tab.host}::${tab.path}`) : null;
  const raw = await runDocktermRemotePy(tab.host, {
    mode: 'poll',
    tmuxSess: tab.tmuxSess,
    sessionId,
    cwd,
    knownPath: known ? known.path : '',
    knownEnd: known ? known.endOffset : 0,
    claimedPaths: Array.from(docktermTabs.values())
      .filter((o) => o !== tab && o.host === tab.host && o.path)
      .map((o) => o.path),
    initialBytes: DOCKTERM_INITIAL_BYTES,
    maxBytes: DOCKTERM_POLL_MAX_BYTES,
  }, 7000);

  if (!raw) {
    tab.stale = true;
    if (!tab.screen) {
      const localTab = activePtyTabs.get(tabId);
      tab.screen = classifyClaudeScreen(localTab ? localTab.scrollback.slice(-40).join('') : '');
    }
    return;
  }

  tab.stale = false;
  tab.claudeRunning = Boolean(raw.claudeRunning);
  tab.launch = { model: raw.launchModel || '', effort: raw.launchEffort || '' };
  tab.claudeCwd = raw.claudeRunning && typeof raw.paneCwd === 'string' ? raw.paneCwd : '';
  tab.screen = classifyClaudeScreen(raw.paneText || '');
  tab.resolvedSessionId = raw.resolvedSessionId || sessionId;

  if (!raw.jsonlPath) {
    tab.path = '';
    return;
  }
  const key = `${tab.host}::${raw.jsonlPath}`;
  let st = docktermTranscripts.get(key);
  const contiguous = st && !raw.reset && raw.chunkStart <= st.endOffset;
  if (!contiguous) {
    st = newTranscriptState(tab.host, raw.jsonlPath, raw.chunkStart);
    docktermTranscripts.set(key, st);
  }
  appendTranscriptRecords(st, Array.isArray(raw.records) ? raw.records : [], raw.chunkStart);
  st.endOffset = Math.max(st.endOffset, Number(raw.chunkEnd) || st.endOffset);
  st.touchedAt = Date.now();
  tab.path = raw.jsonlPath;
}

async function fetchDocktermChatView({ tabId, sessionId, cwd, nodeId, sshHost, epoch: clientEpoch, ver: clientVer }) {
  sweepDocktermCaches();
  const tab = resolveDocktermTarget({ tabId, sessionId, nodeId, sshHost });
  // Coalesce concurrent polls for the same tab into one SSH round-trip
  if (!tab.inflight) {
    tab.inflight = refreshDocktermTab(tab, { tabId, sessionId, cwd })
      .catch(() => { tab.stale = true; })
      .finally(() => { tab.inflight = null; });
  }
  await tab.inflight;

  const st = tab.path ? docktermTranscripts.get(`${tab.host}::${tab.path}`) : null;
  const screen = tab.screen || { status: 'idle', ask: null, tail: '' };
  const epoch = st ? st.epoch : 'none';
  const reset = clientEpoch !== epoch;
  const since = Number(clientVer) || 0;
  let messages = [];
  if (st) {
    st.touchedAt = Date.now();
    messages = reset ? st.messages : st.messages.filter((m) => m.ver > since);
  }
  return {
    ok: true,
    tabId,
    epoch,
    ver: st ? st.ver : 0,
    reset,
    messages,
    total: st ? st.messages.length : 0,
    hasOlder: Boolean(st && st.startOffset > 0),
    resolvedSessionId: tab.resolvedSessionId || sessionId,
    jsonlPath: tab.path,
    claudeRunning: tab.claudeRunning,
    status: screen.status,
    ask: screen.ask,
    tail: screen.tail,
    stale: tab.stale,
    model: st && st.model ? { model: st.model, effort: st.effort, ts: st.modelTs } : null,
    launch: tab.launch || null,
    claudeCwd: tab.claudeCwd || '',
    timestamp: Date.now(),
  };
}

async function fetchDocktermHistory({ tabId, sessionId, nodeId, sshHost, epoch: clientEpoch }) {
  const tab = resolveDocktermTarget({ tabId, sessionId, nodeId, sshHost });
  const st = tab.path ? docktermTranscripts.get(`${tab.host}::${tab.path}`) : null;
  if (!st) return { ok: false, error: '当前没有可加载的对话记录' };
  if (clientEpoch && clientEpoch !== st.epoch) return { ok: false, error: 'epoch-mismatch' };
  if (st.startOffset <= 0) return { ok: true, epoch: st.epoch, ver: st.ver, messages: [], hasOlder: false };

  if (!st.historyInflight) {
    st.historyInflight = (async () => {
      const added = [];
      // Keep paging until something displayable shows up (tool-result-only chunks are common)
      for (let page = 0; page < 3 && st.startOffset > 0 && added.length < 12; page++) {
        const raw = await runDocktermRemotePy(st.host, {
          mode: 'history',
          path: st.path,
          before: st.startOffset,
          chunkBytes: DOCKTERM_HISTORY_BYTES,
        }, 15000);
        if (!raw || raw.error) {
          if (!added.length) throw new Error(raw && raw.error ? raw.error : '加载更早的消息失败');
          break;
        }
        added.unshift(...prependTranscriptRecords(st, Array.isArray(raw.records) ? raw.records : [], raw.chunkStart));
        st.startOffset = Math.min(st.startOffset, Number(raw.chunkStart) || 0);
      }
      return added;
    })().finally(() => { st.historyInflight = null; });
  }
  try {
    const added = await st.historyInflight;
    st.touchedAt = Date.now();
    return { ok: true, epoch: st.epoch, ver: st.ver, messages: added, hasOlder: st.startOffset > 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ============================================================================
// 4C. Local copies on the Mac: remote files, inline chat images, Claude usage/models
//     Everything the UI previews or opens is read from the Mac's disk. Files outside the
//     Syncthing mirror (or not synced yet) are copied once over SSH into a local cache.
// ============================================================================
const TAKT_CACHE_DIR = path.join(BASE_TAKT_DIR, 'cache');
const REMOTE_FILE_CACHE_DIR = path.join(TAKT_CACHE_DIR, 'remote-files');
const CHAT_IMAGE_CACHE_DIR = path.join(TAKT_CACHE_DIR, 'chat-images');
const TAKT_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const REMOTE_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;
const REMOTE_OPEN_MAX_BYTES = 512 * 1024 * 1024;

function sha1Hex(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

function formatByteSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Paths that already live on this Mac (never fetched from a node)
function isLocalMacPath(p) {
  const s = String(p || '');
  return path.isAbsolute(s) && (platform.contains(cfg.HOME, s) || platform.contains(BASE_TAKT_DIR, s) || Boolean(WORKSPACE_LINK_DIR && platform.contains(WORKSPACE_LINK_DIR, s)));
}

function remoteShellPath(p) {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/${shSingleQuote(p.slice(2))}`;
  return shSingleQuote(p);
}

function streamSshToFile(host, command, filePath, timeoutMs) {
  return new Promise((resolve) => {
    let fd;
    try {
      fd = fs.openSync(filePath, 'w');
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      resolve(ok);
    };
    const child = spawn(platform.ssh, [...DOCKTERM_SSH_OPTS, host, command], {
      env: platform.childEnv(), windowsHide: true,
      stdio: ['ignore', fd, 'ignore'],
    });
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

let taktCacheLastPrune = 0;
async function pruneTaktCache() {
  const now = Date.now();
  if (now - taktCacheLastPrune < 3600 * 1000) return;
  taktCacheLastPrune = now;
  const walk = async (dir, depth) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (depth > 0) await walk(p, depth - 1);
          const left = await fsp.readdir(p);
          if (!left.length) await fsp.rmdir(p);
        } else if (now - (await fsp.stat(p)).mtimeMs > TAKT_CACHE_MAX_AGE_MS) {
          await fsp.rm(p, { force: true });
        }
      } catch {}
    }
  };
  await walk(REMOTE_FILE_CACHE_DIR, 2);
  await walk(CHAT_IMAGE_CACHE_DIR, 0);
}

const remoteFileInflight = new Map();
const remoteFileMisses = new Map(); // short negative cache: a gallery of missing paths must not hammer SSH

/** Copy a node file into the Mac cache (re-used while size + mtime are unchanged). */
async function ensureRemoteFileCopy(node, remotePath, maxBytes = REMOTE_PREVIEW_MAX_BYTES) {
  const rp = String(remotePath || '');
  if (!node || !node.sshHost || !(rp.startsWith('/') || rp.startsWith('~/')) || isLocalMacPath(rp)) {
    return { ok: false, error: 'Mac 本地没有这个文件，也没有可读取它的远端节点' };
  }
  const key = `${node.id}::${rp}`;
  const miss = remoteFileMisses.get(key);
  if (miss && Date.now() - miss.at < 15000) return miss.result;
  if (remoteFileInflight.has(key)) return remoteFileInflight.get(key);

  const job = (async () => {
    const q = remoteShellPath(rp);
    const st = await runCmd('ssh', [...DOCKTERM_SSH_OPTS, node.sshHost, `stat -L -c '%s %Y %F' -- ${q}`], 8000);
    const m = (st.stdout.trim().split('\n').pop() || '').match(/^(\d+) (\d+) (.+)$/);
    if (st.exitCode !== 0 || !m) return { ok: false, error: `Mac 本地和节点 ${node.badge || node.id} 上都没有找到这个文件`, missing: true };
    const size = Number(m[1]);
    const mtime = Number(m[2]);
    if (!/regular/.test(m[3])) {
      const isDir = /directory/.test(m[3]);
      return { ok: false, isDir, missing: true, error: isDir ? '这是一个目录' : '不是普通文件' };
    }
    if (size > maxBytes) {
      return { ok: false, tooLarge: true, size, error: `文件太大（${formatByteSize(size)}），超过 ${formatByteSize(maxBytes)} 的拷贝上限` };
    }
    const dir = path.join(REMOTE_FILE_CACHE_DIR, String(node.id).replace(/[^a-zA-Z0-9_-]/g, '_'), sha1Hex(rp).slice(0, 16));
    const localPath = path.join(dir, path.posix.basename(rp) || 'file');
    const metaPath = path.join(dir, '.meta.json');
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      if (meta.size === size && meta.mtime === mtime && fs.existsSync(localPath)) {
        return { ok: true, localPath, size, cached: true };
      }
    } catch {}
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${localPath}.part-${process.pid}-${Date.now()}`;
    const ok = await streamSshToFile(node.sshHost, `cat -- ${q}`, tmp, 20000 + Math.ceil(size / (1024 * 1024)) * 3000);
    let got = -1;
    try { got = (await fsp.stat(tmp)).size; } catch {}
    if (!ok || got !== size) {
      await fsp.rm(tmp, { force: true });
      return { ok: false, error: '从节点拷贝文件失败（文件可能正在写入）' };
    }
    await fsp.rename(tmp, localPath);
    await fsp.writeFile(metaPath, JSON.stringify({ remotePath: rp, nodeId: node.id, size, mtime, fetchedAt: Date.now() }));
    pruneTaktCache().catch(() => {});
    return { ok: true, localPath, size, cached: false };
  })()
    .catch((err) => ({ ok: false, error: err.message }))
    .then((result) => {
      if (!result.ok && result.missing) remoteFileMisses.set(key, { at: Date.now(), result });
      else remoteFileMisses.delete(key);
      return result;
    })
    .finally(() => remoteFileInflight.delete(key));
  remoteFileInflight.set(key, job);
  return job;
}

/** Resolve a path from the conversation to something readable on this Mac. */
async function resolveReadableLocalFile(reqPath, cwd, nodeId, maxBytes = REMOTE_PREVIEW_MAX_BYTES) {
  const r = resolveAnyFilePathToLocalAndRemote(reqPath, cwd, nodeId);
  if (r.localPath) {
    try {
      const st = fs.statSync(r.localPath);
      return { ...r, readPath: r.localPath, fromRemote: false, isDir: st.isDirectory(), size: st.size };
    } catch {}
  }
  const copy = await ensureRemoteFileCopy(r.node, r.remotePath, maxBytes);
  if (!copy.ok) return { ...r, readPath: '', fromRemote: false, error: copy.error, isDir: Boolean(copy.isDir), tooLarge: Boolean(copy.tooLarge), size: copy.size };
  return { ...r, readPath: copy.localPath, fromRemote: true, isDir: false, size: copy.size };
}

const CHAT_IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const chatImageInflight = new Map();

/** Images pasted into the conversation live base64-encoded in the node's transcript. */
async function ensureChatImageCopy({ nodeId, path: jsonlPath, off, idx, u }) {
  const node = getNodeById(nodeId);
  const host = node && node.sshHost;
  const p = String(jsonlPath || '');
  const o = Number(off);
  const i = Number(idx);
  if (!host || !/\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(p) || !Number.isInteger(o) || o < 0 || !Number.isInteger(i) || i < 0 || i > 256) {
    return { ok: false, error: '图片引用无效' };
  }
  const key = sha1Hex(`${host}|${p}|${o}|${i}|${u || ''}`).slice(0, 24);
  for (const ext of new Set(Object.values(CHAT_IMAGE_EXT))) {
    const f = path.join(CHAT_IMAGE_CACHE_DIR, key + ext);
    if (fs.existsSync(f)) return { ok: true, localPath: f };
  }
  if (chatImageInflight.has(key)) return chatImageInflight.get(key);
  const job = (async () => {
    const raw = await runDocktermRemotePy(host, { mode: 'image', path: p, off: o, idx: i, uuid: String(u || '') }, 20000);
    if (!raw || raw.error || typeof raw.data !== 'string') {
      return { ok: false, error: raw && raw.error === 'moved' ? '对话记录已变化，找不到这张图片' : '从节点读取图片失败' };
    }
    const ext = CHAT_IMAGE_EXT[String(raw.mediaType || '').toLowerCase()];
    if (!ext) return { ok: false, error: `不支持的图片格式 ${raw.mediaType}` };
    await fsp.mkdir(CHAT_IMAGE_CACHE_DIR, { recursive: true });
    const f = path.join(CHAT_IMAGE_CACHE_DIR, key + ext);
    const tmp = `${f}.part-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, Buffer.from(raw.data, 'base64'));
    await fsp.rename(tmp, f);
    pruneTaktCache().catch(() => {});
    return { ok: true, localPath: f };
  })()
    .catch((err) => ({ ok: false, error: err.message }))
    .finally(() => chatImageInflight.delete(key));
  chatImageInflight.set(key, job);
  return job;
}

// What `open` may do with a file. Documents open in their app, text in the text editor;
// anything that could execute (apps, scripts with a launcher, unknown binaries) is only revealed.
const MAC_OPEN_DOC_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.svg', '.ico', '.psd',
  '.pdf', '.html', '.htm',
  '.glb', '.gltf', '.stl', '.obj', '.fbx', '.3mf', '.ply', '.usdz', '.step', '.stp', '.iges', '.igs',
  '.fcstd', '.blend', '.dxf', '.dwg', '.epro', '.epro2', '.kicad_pcb', '.kicad_sch', '.kicad_pro',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.key', '.pages', '.numbers', '.rtf', '.csv',
  '.mp4', '.mov', '.m4v', '.webm', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg',
]);
const MAC_OPEN_TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.less', '.xml',
  '.py', '.ipynb', '.sh', '.bash', '.zsh', '.fish', '.c', '.cc', '.cpp', '.h', '.hpp', '.m', '.mm', '.swift',
  '.rs', '.go', '.java', '.kt', '.rb', '.php', '.pl', '.lua', '.r', '.sql', '.cmake', '.mk', '.ld', '.s',
  '.gitignore', '.stignore', '.dockerfile', '.lock',
]);

function macOpenArgs(target, reveal) {
  if (reveal) return { mode: 'reveal', args: ['-R', target] };
  let st = null;
  try { st = fs.statSync(target); } catch {}
  if (!st) return { mode: 'reveal', args: ['-R', target] };
  if (st.isDirectory()) {
    return /\.(app|bundle|framework|plugin|kext|prefpane|workflow|action|pkg|mpkg|saver|qlgenerator)$/i.test(target)
      ? { mode: 'reveal', args: ['-R', target] }
      : { mode: 'open', args: [target] };
  }
  const ext = path.extname(target).toLowerCase();
  const base = path.basename(target).toLowerCase();
  if (MAC_OPEN_DOC_EXTS.has(ext)) return { mode: 'open', args: [target] };
  if (MAC_OPEN_TEXT_EXTS.has(ext) || ['dockerfile', 'makefile', 'readme', 'license', 'claude.md'].includes(base)) {
    return { mode: 'text', args: ['-t', target] };
  }
  return { mode: 'reveal', args: ['-R', target] };
}

// Attachments for a prompt: <session cwd>/.takt/uploads/<stamp>-<name> on the node. The folder
// carries a "*" .gitignore so uploads never show up in the project's git status.
const CHAT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

function chatUploadName(raw) {
  const base = path.posix.basename(String(raw || '').replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '').trim();
  const safe = base.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').replace(/^[.\-]+/, '').slice(-80) || 'file';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}-${safe}`;
}

function uploadChatAttachment(node, cwd, rawName, stream, size) {
  const dir = path.posix.join(cwd.replace(/\/+$/, '') || '/', '.takt', 'uploads');
  const name = chatUploadName(rawName);
  const remotePath = path.posix.join(dir, name);
  const qd = shSingleQuote(dir);
  const qf = shSingleQuote(remotePath);
  const qp = shSingleQuote(`${remotePath}.part`);
  const cmd = `mkdir -p ${qd} && { [ -e ${qd}/.gitignore ] || printf '*\\n' > ${qd}/.gitignore; } && cat > ${qp} && mv -f ${qp} ${qf} && echo takt-upload-ok`;
  return new Promise((resolve) => {
    let settled = false;
    let received = 0;
    let out = '';
    let err = '';
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(platform.ssh, [...DOCKTERM_SSH_OPTS, node.sshHost, cmd], {
      env: platform.childEnv(), windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, error: '上传超时' });
    }, 30000 + Math.ceil(size / (1024 * 1024)) * 4000);
    stream.on('data', (chunk) => {
      received += chunk.length;
      if (received > CHAT_UPLOAD_MAX_BYTES) {
        try { child.kill('SIGKILL'); } catch {}
        finish({ ok: false, error: '文件太大' });
      }
    });
    stream.on('error', () => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, error: '上传中断' });
    });
    child.stdin.on('error', () => {});
    stream.pipe(child.stdin);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code === 0 && out.includes('takt-upload-ok') && received === size) {
        finish({ ok: true, remotePath, name, size: received });
      } else {
        finish({ ok: false, error: (err.trim().split('\n').pop() || `上传失败（${code}）`).slice(0, 200) });
      }
    });
  });
}

// Claude usage (/usage) and model list (/model) per node — fetched on the node with its own
// OAuth credentials; nothing is typed into the terminal.
const claudeMetaCache = new Map(); // host -> { usage: {at, data}, models: {at, data} }

async function fetchClaudeMeta({ nodeId, cwd, parts, force }) {
  const node = getNodeById(nodeId);
  const host = node && node.sshHost;
  if (!host) return { ok: false, error: '该节点没有配置 SSH 主机' };
  const want = new Set(String(parts || 'usage,models,current').split(',').map((x) => x.trim()).filter(Boolean));
  const now = Date.now();
  let c = claudeMetaCache.get(host);
  if (!c) {
    c = {};
    claudeMetaCache.set(host, c);
  }
  const need = [];
  if (want.has('usage') && (force || !c.usage || now - c.usage.at > 60 * 1000)) need.push('usage');
  if (want.has('models') && (force || !c.models || now - c.models.at > (c.models.data.models.length ? 6 * 3600 * 1000 : 60 * 1000))) need.push('models');
  if (want.has('current')) need.push('current');

  let settings = null;
  let error = '';
  if (need.length) {
    const raw = await runDocktermRemotePy(host, { mode: 'meta', parts: need, cwd: String(cwd || '') }, 15000);
    if (!raw) {
      error = '无法连接节点';
    } else {
      if (need.includes('usage')) c.usage = { at: now, data: { usage: raw.usage || null, error: raw.usageError || '', plan: raw.plan || '' } };
      if (need.includes('models')) c.models = { at: now, data: { models: Array.isArray(raw.models) ? raw.models : [], extraModels: Array.isArray(raw.extraModels) ? raw.extraModels : [], error: raw.modelsError || '' } };
      if (need.includes('current')) settings = raw.settings || null;
    }
  }
  const out = { ok: !error || Boolean(c.usage || c.models), nodeId: node.id, error };
  if (want.has('usage')) {
    out.usage = c.usage ? c.usage.data.usage : null;
    out.usageError = c.usage ? c.usage.data.error : error;
    out.plan = c.usage ? c.usage.data.plan : '';
    out.usageCheckedAt = c.usage ? c.usage.at : 0;
  }
  if (want.has('models')) {
    out.models = c.models ? c.models.data.models : [];
    out.extraModels = c.models ? c.models.data.extraModels : [];
    out.modelsError = c.models ? c.models.data.error : error;
  }
  if (want.has('current')) out.settings = settings;
  return out;
}

// ============================================================================
// 5. HTTP & WebSocket Server
// ============================================================================
function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    // --- Local-only guard: blocks DNS-rebinding (bad Host) and cross-site requests (bad Origin) ---
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden host');
      return;
    }
    if (req.headers.origin && !isSameLocalOrigin(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden origin');
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'takt-workbench', pid: process.pid, platform: process.platform, dataDir: cfg.TAKT_HOME });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/shutdown') {
      if (!hasBearerToken(req.headers, MCP_TOKEN)) { sendJson(res, 401, { ok: false }); return; }
      sendJson(res, 200, { ok: true });
      setTimeout(shutdown, 50);
      return;
    }
    // Only named application assets are public; no arbitrary filesystem route.
    const assets = new Set(['workbench.css', 'workbench.js', 'icons.js', 'nodes.js']);
    if (req.method === 'GET' && u.pathname.startsWith('/assets/')) {
      const name = u.pathname.slice('/assets/'.length);
      if (!assets.has(name)) { sendJson(res, 404, { ok: false }); return; }
      res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
      fs.createReadStream(path.join(PUBLIC_DIR, 'assets', name)).pipe(res);
      return;
    }

    // Serve vendor static files
    if (req.method === 'GET' && u.pathname.startsWith('/vendor/')) {
      const fileName = path.basename(u.pathname);
      const filePath = path.join(VENDOR_DIR, fileName);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(fileName).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // Serve main UI
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      const htmlPath = path.join(PUBLIC_DIR, 'index.html');
      const html = await fsp.readFile(htmlPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    // API: Get Multi-Node Projects & Conversations Tree + Active Tabs (Served from Local SQLite in <1ms)
    if (req.method === 'GET' && u.pathname === '/api/tree') {
      const forceSync = u.searchParams.get('sync') === '1';
      if (forceSync || sessionIndex.getLastSyncAt() === 0) {
        await syncAllNodesToSqlite();
      } else if (Date.now() - sessionIndex.getLastSyncAt() > 6000) {
        syncAllNodesToSqlite().catch(() => {});
      }
      const tree = readTreeFromSqlite();
      const openTabs = Array.from(activePtyTabs.values()).map((t) => ({
        tabId: t.tabId,
        sessionId: t.sessionId,
        title: t.title,
        cwd: t.cwd,
        nodeId: t.nodeId,
        nodeName: t.nodeName,
        nodeBadge: t.nodeBadge,
        sshHost: t.sshHost,
        localWorkDir: t.localWorkDir,
        localWorkAlias: t.localWorkAlias,
        mode: t.mode,
        createdAt: t.createdAt,
      }));
      sendJson(res, 200, { ...tree, ...readTagsFromSqlite(), openTabs });
      return;
    }

    // API: Tags CRUD (local SQLite)
    if (u.pathname === '/api/tags' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim().slice(0, 24);
      if (!name) { sendJson(res, 400, { ok: false, error: '标签名不能为空' }); return; }
      const id = `tag_${crypto.randomUUID().slice(0, 8)}`;
      const maxSort = workbenchDb.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM tags').get().m;
      workbenchDb.prepare('INSERT INTO tags (id, name, color, sort, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, String(body.color || 'blue'), maxSort + 1, Date.now());
      sendJson(res, 200, { ok: true, id, ...readTagsFromSqlite() });
      return;
    }
    if (u.pathname === '/api/tags' && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const id = String(body.id || '');
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 24);
        if (name) workbenchDb.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
      }
      if (body.color) workbenchDb.prepare('UPDATE tags SET color = ? WHERE id = ?').run(String(body.color), id);
      sendJson(res, 200, { ok: true, ...readTagsFromSqlite() });
      return;
    }
    if (u.pathname === '/api/tags' && req.method === 'DELETE') {
      const id = String(u.searchParams.get('id') || '');
      workbenchDb.prepare('DELETE FROM tags WHERE id = ?').run(id);
      workbenchDb.prepare('DELETE FROM project_tags WHERE tag_id = ?').run(id);
      sendJson(res, 200, { ok: true, ...readTagsFromSqlite() });
      return;
    }
    if (u.pathname === '/api/project-tag' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const key = String(body.projectKey || '');
      const tagId = body.tagId ? String(body.tagId) : '';
      if (!key) { sendJson(res, 400, { ok: false, error: 'Missing projectKey' }); return; }
      if (tagId) {
        workbenchDb.prepare('INSERT INTO project_tags (project_key, tag_id) VALUES (?, ?) ON CONFLICT(project_key) DO UPDATE SET tag_id = excluded.tag_id').run(key, tagId);
        // Tagged projects should always stay visible in the sidebar
        workbenchDb.prepare('UPDATE projects SET pinned_visible = 1 WHERE key = ?').run(key);
      } else {
        workbenchDb.prepare('DELETE FROM project_tags WHERE project_key = ?').run(key);
      }
      sendJson(res, 200, { ok: true, ...readTagsFromSqlite() });
      return;
    }

    // API: List Configured Linux Nodes + Discovered ~/.ssh/config Hosts
    if (req.method === 'GET' && u.pathname === '/api/nodes') {
      const nodes = loadNodes();
      const sshCandidates = discoverSshConfigHosts();
      sendJson(res, 200, { ok: true, nodes, sshCandidates });
      return;
    }

    // API: Create or Update a Linux Node (binds SSH Host <-> local workN + Syncthing + MCP Reverse Tunnel)
    if (req.method === 'POST' && u.pathname === '/api/nodes') {
      const body = await readJsonBody(req);
      const nodes = loadNodes();
      const id = String(body.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || `linux-${Date.now().toString(36)}`;
      const name = String(body.name || '').trim() || id;
      const badge = String(body.badge || '').trim().slice(0, 8) || `LX-${nodes.length + 1}`;
      const sshHost = String(body.sshHost || '').trim();
      const remoteWorkDir = (String(body.remoteWorkDir || '/root/work').trim().replace(/\/+$/, '')) || '/root/work';
      const aliasRaw = String(body.localWorkAlias || `work${nodes.length + 1}`).trim().replace(/[^a-zA-Z0-9_-]/g, '') || `work${nodes.length + 1}`;
      const localWorkDir = path.join(BASE_TAKT_DIR, aliasRaw);
      const syncthingFolderId = String(body.syncthingFolderId || `takt-${aliasRaw}`).trim();
      const enabled = body.enabled !== undefined ? Boolean(body.enabled) : Boolean(sshHost);

      let target = nodes.find((n) => n.id === id);
      const previous = target ? { ...target } : null;
      if (target) {
        target.name = name;
        target.badge = badge;
        target.sshHost = sshHost;
        target.remoteWorkDir = remoteWorkDir;
        target.localWorkAlias = aliasRaw;
        target.localWorkDir = localWorkDir;
        target.syncthingFolderId = syncthingFolderId;
        target.enabled = enabled;
      } else {
        target = {
          id,
          name,
          badge,
          sshHost,
          remoteWorkDir,
          localWorkDir,
          localWorkAlias: aliasRaw,
          syncthingFolderId,
          syncthingDeviceId: '',
          enabled,
        };
        nodes.push(target);
      }

      try { validateNodes(nodes); } catch (error) { sendJson(res, 400, { ok: false, error: error.message }); return; }
      saveNodes(nodes);
      if (previous?.sshHost && (!target.enabled || previous.sshHost !== target.sshHost)) {
        if (!platform.isWindows) await runCmd('ssh', ['-S', nodeTunnelSock(cfg, previous), '-O', 'exit', previous.sshHost], 2500);
      }
      const prov = target.enabled ? await provisionLinuxNode(target) : { ok: true, logs: [] };
      const latestNodes = loadNodes();
      const latestTarget = latestNodes.find((n) => n.id === target.id);
      if (latestTarget && latestTarget.sshHost === target.sshHost) {
        latestTarget.remoteWorkDir = target.remoteWorkDir;
        latestTarget.syncthingDeviceId = target.syncthingDeviceId;
        saveNodes(latestNodes);
      }
      syncAllNodesToSqlite().catch(() => {});
      if (target.enabled) mcpFetch('/system-heal', { method: 'POST' }).catch(() => {});
      sendJson(res, prov.ok ? 200 : 502, { ok: prov.ok, node: target, nodes, logs: prov.logs });
      return;
    }

    // API: Delete a non-primary Linux Node config (never deletes local workN files)
    if (req.method === 'DELETE' && u.pathname === '/api/nodes') {
      const id = String(u.searchParams.get('id') || '').trim();
      if (!id || id === loadNodes()[0].id) {
        sendJson(res, 400, { ok: false, error: '主节点不可删除' });
        return;
      }
      const previous = loadNodes().find((n) => n.id === id);
      const nodes = loadNodes().filter((n) => n.id !== id);
      saveNodes(nodes);
      if (previous?.sshHost && !platform.isWindows) await runCmd('ssh', ['-S', nodeTunnelSock(cfg, previous), '-O', 'exit', previous.sshHost], 2500);
      sendJson(res, 200, { ok: true, nodes });
      return;
    }

    // API: Instabox Remote Desktop Plugin (noVNC Web + macOS Native Screen Sharing + AI/Human Control)
    if (u.pathname === '/api/remote-desktop' && req.method === 'POST') {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const r = await mcpFetch('/remote-desktop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: body.action || u.searchParams.get('action') || 'start',
          nodeId: body.nodeId || u.searchParams.get('nodeId') || '',
        }),
      });
      const data = await r.json();
      sendJson(res, r.status, data);
      return;
    }

    // API: Create a new project folder on the specified Linux node & its paired Mac local workN folder
    if (req.method === 'POST' && u.pathname === '/api/projects') {
      const body = await readJsonBody(req);
      const rawName = String(body.name || '').trim().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5. ]/g, '').trim();
      if (!rawName) {
        sendJson(res, 400, { ok: false, error: '项目名称不能为空' });
        return;
      }
      const node = getNodeById(body.nodeId);
      const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
      const localDir = path.join(node.localWorkDir, rawName);
      const remoteDir = `${remoteRoot}/${rawName}`;
      await fsp.mkdir(localDir, { recursive: true });
      upsertProjectInSqlite(node, remoteDir, rawName, 1);
      if (node.enabled && node.sshHost) {
        await runCmd('ssh', ['-o', 'ConnectTimeout=4', '-o', 'ClearAllForwardings=yes', node.sshHost, `mkdir -p ${shSingleQuote(remoteDir)}`], 5000);
      }
      sendJson(res, 200, {
        ok: true,
        key: `${node.id}::${remoteDir}`,
        nodeId: node.id,
        nodeBadge: node.badge,
        sshHost: node.sshHost,
        localWorkAlias: node.localWorkAlias,
        localPath: localDir,
        path: remoteDir,
        name: rawName,
      });
      return;
    }

    // API: Immediately register a newly launched session in Local SQLite (for Native SwiftTerm & Web PTY)
    if (req.method === 'POST' && u.pathname === '/api/sessions/register') {
      const body = await readJsonBody(req);
      const sid = String(body.id || '').trim();
      if (!sid) {
        sendJson(res, 400, { ok: false, error: 'Missing session id' });
        return;
      }
      registerSessionInSqlite({
        id: sid,
        nodeId: body.nodeId || loadNodes()[0].id,
        cwd: body.cwd || '/root/work',
        title: body.title || `会话 ${sid.slice(0, 8)}`,
      });
      sendJson(res, 200, { ok: true, id: sid });
      return;
    }

    // API: Rename a session (persists in Local SQLite + appends custom-title to remote .jsonl if present)
    if (req.method === 'POST' && u.pathname === '/api/sessions/rename') {
      const body = await readJsonBody(req);
      const sid = String(body.id || '').trim();
      const title = String(body.title || '').trim().slice(0, 120);
      const node = getNodeById(body.nodeId);
      if (!sid || !/^[a-zA-Z0-9_-]+$/.test(sid) || !title) {
        sendJson(res, 400, { ok: false, error: '会话 ID 或新名称不能为空' });
        return;
      }
      saveCustomSessionTitle(sid, title, node.id);
      for (const tab of activePtyTabs.values()) {
        if (tab.sessionId === sid && tab.nodeId === node.id) tab.title = title;
      }
      if (node && node.enabled && node.sshHost) {
        const lineJson = JSON.stringify({ type: 'custom-title', customTitle: title });
        const b64Line = Buffer.from(lineJson + '\n', 'utf8').toString('base64');
        runCmd('ssh', [
          '-o', 'ConnectTimeout=3',
          '-o', 'ClearAllForwardings=yes',
          node.sshHost,
          `for f in ~/.claude/projects/*/${sid}.jsonl; do [ -f "$f" ] && echo '${b64Line}' | base64 -d >> "$f"; done`,
        ], 4000).catch(() => {});
      }
      sendJson(res, 200, { ok: true, id: sid, title });
      return;
    }

    // API: Delete a session (soft-deletes in Local SQLite immediately + deletes remote .jsonl)
    if (req.method === 'DELETE' && u.pathname === '/api/sessions') {
      const sid = String(u.searchParams.get('id') || '').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const node = getNodeById(nodeId);
      if (!sid || !/^[a-zA-Z0-9_-]+$/.test(sid)) {
        sendJson(res, 400, { ok: false, error: 'Invalid session id' });
        return;
      }
      stmtSoftDeleteSession.run(Date.now(), node.id, sid);
      saveCustomSessionTitle(sid, '', node.id);
      const matchingTabs = [...activePtyTabs.values()].filter((tab) => tab.sessionId === sid && tab.nodeId === node.id);
      if (matchingTabs.length) for (const tab of matchingTabs) closePtyTab(tab.tabId, node.id);
      else closePtyTab(sid, node.id);
      if (node && node.enabled && node.sshHost) {
        await runCmd('ssh', [
          '-o', 'ConnectTimeout=4',
          '-o', 'ClearAllForwardings=yes',
          node.sshHost,
          `find ~/.claude/projects -name ${shSingleQuote(sid + '.jsonl')} -delete`,
        ], 5000);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // API: Close a specific Terminal Tab and terminate its CLI PTY
    if (req.method === 'DELETE' && u.pathname === '/api/tabs') {
      const tabId = String(u.searchParams.get('tabId') || '').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const closed = closePtyTab(tabId, nodeId);
      sendJson(res, 200, { ok: true, closed });
      return;
    }

    // API: Live file-tree change stream (SSE). The UI reloads the tree silently on each "change" event,
    // so the right-hand file panel stays current without pressing refresh.
    if (req.method === 'GET' && u.pathname === '/api/files-events') {
      const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const node = inferNodeFromPathOrId(cwd, nodeId);
      const localRoot = mapRemoteCwdToLocal(cwd, node.id);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const unsubscribe = subscribeFileChanges(localRoot, () => { try { res.write('event: change\ndata: 1\n\n'); } catch {} });
      res.write(unsubscribe ? 'event: ready\ndata: 1\n\n' : 'event: nowatch\ndata: 1\n\n');
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(ka); if (unsubscribe) unsubscribe(); });
      return;
    }

    // API: List files for a session's project directory (Mac Local Disk for that node's work/work2)
    if (req.method === 'GET' && u.pathname === '/api/files') {
      const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const node = inferNodeFromPathOrId(cwd, nodeId);
      const localRoot = mapRemoteCwdToLocal(cwd, node.id);
      const tree = await buildFileTree(localRoot, cwd, node);
      sendJson(res, 200, tree);
      return;
    }

    // API: Read text/code file content for Right Panel Preview (100% Mac Local Path + Strict Whitelist + Fast Size Guard)
    if (req.method === 'GET' && u.pathname === '/api/file-content') {
      const reqPath = String(u.searchParams.get('path') || '').trim();
      const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      if (!reqPath) {
        sendJson(res, 400, { ok: false, error: 'Missing path' });
        return;
      }
      const { localPath, remotePath, lineNum, node } = resolveAnyFilePathToLocalAndRemote(reqPath, cwd, nodeId);
      const displayPath = localPath || remotePath;
      const baseName = path.basename(displayPath);
      const lowerBase = baseName.toLowerCase();
      const ext = path.extname(lowerBase);

      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
      const WEB_EXTS = new Set(['.html', '.htm']);
      const CODE_EXTS = new Set([
        '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh',
        '.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env', '.md', '.txt',
        '.css', '.scss', '.less', '.c', '.cpp', '.cc', '.h', '.hpp', '.swift', '.rs',
        '.go', '.java', '.kt', '.sql', '.xml', '.csv', '.vue', '.svelte', '.lua',
        '.rb', '.php', '.pl', '.r', '.m', '.mm', '.cmake', '.mk', '.dockerfile',
        '.gitignore', '.stignore', '.log',
      ]);
      const CODE_BASENAMES = new Set(['dockerfile', 'makefile', 'claude.md', 'readme', 'license', '.gitignore', '.stignore', '.env']);

      const isImage = IMAGE_EXTS.has(ext);
      const isWeb = WEB_EXTS.has(ext);
      const isCode = CODE_EXTS.has(ext) || CODE_BASENAMES.has(lowerBase);

      const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
      const MAX_WEB_BYTES = 2 * 1024 * 1024;
      const MAX_CODE_BYTES = 200 * 1024;

      let localStat = null;
      let readPath = localPath;
      let fromRemote = false;
      if (localPath && fs.existsSync(localPath)) {
        try { localStat = await fsp.stat(localPath); } catch {}
      }
      // Not on this Mac (outside the mirror / not synced yet): copy it from the node first
      if (!localStat && (isImage || isWeb || isCode)) {
        const copy = await ensureRemoteFileCopy(node, remotePath, isImage ? MAX_IMAGE_BYTES : isWeb ? MAX_WEB_BYTES : MAX_CODE_BYTES);
        if (copy.ok) {
          readPath = copy.localPath;
          fromRemote = true;
          try { localStat = await fsp.stat(readPath); } catch {}
        } else if (copy.isDir) {
          sendJson(res, 200, { ok: true, kind: 'directory', path: displayPath, localPath: '', remotePath, nodeId: node.id, name: baseName });
          return;
        } else if (copy.tooLarge) {
          sendJson(res, 200, {
            ok: true,
            kind: 'unsupported',
            path: displayPath,
            localPath: '',
            remotePath,
            nodeId: node.id,
            name: baseName,
            ext,
            size: copy.size,
            reason: copy.error,
          });
          return;
        } else if (remotePath && !isLocalMacPath(remotePath)) {
          sendJson(res, 404, { ok: false, error: copy.error || `没有找到该文件: ${displayPath}` });
          return;
        }
      }

      if (localStat && localStat.isDirectory()) {
        sendJson(res, 200, { ok: true, kind: 'directory', path: displayPath, localPath, remotePath, nodeId: node.id, name: baseName });
        return;
      }

      if (!isImage && !isWeb && !isCode) {
        sendJson(res, 200, {
          ok: true,
          kind: 'unsupported',
          path: displayPath,
          localPath,
          remotePath,
          nodeId: node.id,
          name: baseName,
          ext: ext || '无后缀',
          size: localStat ? localStat.size : null,
          reason: `不支持预览 ${ext || '二进制/工程'} 类型文件（仅预览图片、网页与代码文件）`,
        });
        return;
      }

      if (!localStat) {
        sendJson(res, 404, { ok: false, error: `Mac 本地路径下未找到该文件: ${displayPath}` });
        return;
      }

      if (isImage) {
        if (localStat.size > MAX_IMAGE_BYTES) {
          sendJson(res, 200, {
            ok: true,
            kind: 'unsupported',
            path: displayPath,
            localPath,
            remotePath,
            nodeId: node.id,
            name: baseName,
            ext,
            size: localStat.size,
            reason: '图片体积超过 12 MB 阈值，已跳过加载以避免界面卡顿',
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          kind: 'image',
          fromRemote,
          path: displayPath,
          localPath,
          remotePath,
          nodeId: node.id,
          name: baseName,
          ext,
          size: localStat.size,
          rawUrl: `/api/raw-file?path=${encodeURIComponent(displayPath)}&cwd=${encodeURIComponent(cwd)}&nodeId=${encodeURIComponent(node.id)}&t=${Date.now()}`,
        });
        return;
      }

      if (isWeb) {
        if (localStat.size > MAX_WEB_BYTES) {
          sendJson(res, 200, {
            ok: true,
            kind: 'unsupported',
            path: displayPath,
            localPath,
            remotePath,
            nodeId: node.id,
            name: baseName,
            ext,
            size: localStat.size,
            reason: '网页文件超过 2 MB 阈值，已跳过内嵌渲染',
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          kind: 'html',
          fromRemote,
          path: displayPath,
          localPath,
          remotePath,
          nodeId: node.id,
          name: baseName,
          ext,
          size: localStat.size,
          rawUrl: `/api/raw-file?path=${encodeURIComponent(displayPath)}&cwd=${encodeURIComponent(cwd)}&nodeId=${encodeURIComponent(node.id)}`,
        });
        return;
      }

      if (localStat.size > MAX_CODE_BYTES) {
        sendJson(res, 200, {
          ok: true,
          kind: 'unsupported',
          path: displayPath,
          localPath,
          remotePath,
          nodeId: node.id,
          name: baseName,
          ext,
          size: localStat.size,
          reason: '代码/文本文件超过 200 KB 大文件阈值，为保证秒开流畅不直接加载',
        });
        return;
      }

      const buf = await fsp.readFile(readPath);
      const sampleLen = Math.min(buf.length, 4096);
      for (let i = 0; i < sampleLen; i++) {
        if (buf[i] === 0) {
          sendJson(res, 200, {
            ok: true,
            kind: 'unsupported',
            path: displayPath,
            localPath,
            remotePath,
            nodeId: node.id,
            name: baseName,
            ext,
            size: localStat.size,
            reason: '检测到二进制字节内容，已跳过文本预览',
          });
          return;
        }
      }

      sendJson(res, 200, {
        ok: true,
        kind: ext === '.md' ? 'markdown' : 'code',
        fromRemote,
        path: displayPath,
        localPath,
        remotePath,
        nodeId: node.id,
        name: baseName,
        ext,
        size: localStat.size,
        lineNum,
        content: buf.toString('utf8'),
        rawUrl: `/api/raw-file?path=${encodeURIComponent(displayPath)}&cwd=${encodeURIComponent(cwd)}&nodeId=${encodeURIComponent(node.id)}`,
      });
      return;
    }

    // API: Stream raw file directly from Mac local disk
    if (req.method === 'GET' && u.pathname === '/api/raw-file') {
      const reqPath = String(u.searchParams.get('path') || '').trim();
      const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const found = await resolveReadableLocalFile(reqPath, cwd, nodeId, REMOTE_PREVIEW_MAX_BYTES);
      const ext = path.extname(found.localPath || found.remotePath || '').toLowerCase();
      const contentType = MIME_MAP[ext] || 'application/octet-stream';

      if (found.readPath && !found.isDir) {
        // Pages from a node run in an opaque origin: their scripts can't drive this workbench's API
        const active = ['.html', '.htm', '.xhtml', '.svg'].includes(ext);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          ...(active ? { 'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals' } : {}),
        });
        fs.createReadStream(found.readPath).pipe(res);
        return;
      }

      res.writeHead(404);
      res.end('Local file not found');
      return;
    }

    // API: image pasted into a Claude conversation (cached on the Mac after the first view)
    if (req.method === 'GET' && u.pathname === '/api/chat-image') {
      const r = await ensureChatImageCopy({
        nodeId: u.searchParams.get('nodeId') || '',
        path: u.searchParams.get('path') || '',
        off: u.searchParams.get('off'),
        idx: u.searchParams.get('idx'),
        u: u.searchParams.get('u') || '',
      });
      if (!r.ok) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(r.error || 'not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME_MAP[path.extname(r.localPath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'private, max-age=604800, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(r.localPath).pipe(res);
      return;
    }

    // API: open a file from the conversation with its Mac app (or reveal it in Finder)
    if (req.method === 'POST' && u.pathname === '/api/open-local') {
      const body = await readJsonBody(req);
      let target = '';
      let fromRemote = false;
      if (body.chatImage && typeof body.chatImage === 'object') {
        const r = await ensureChatImageCopy(body.chatImage);
        if (!r.ok) {
          sendJson(res, 404, { ok: false, error: r.error });
          return;
        }
        target = r.localPath;
        fromRemote = true;
      } else {
        const r = await resolveReadableLocalFile(String(body.path || ''), String(body.cwd || ''), String(body.nodeId || ''), REMOTE_OPEN_MAX_BYTES);
        if (!r.readPath) {
          sendJson(res, 404, { ok: false, error: r.error || '没有找到该文件' });
          return;
        }
        target = r.readPath;
        fromRemote = r.fromRemote;
      }
      const how = macOpenArgs(target, Boolean(body.reveal));
      const opener = process.platform === 'darwin' ? { command: 'open', args: how.args } : platform.isWindows && how.mode === 'text'
        ? { command: 'notepad.exe', args: [target] } : platform.openTarget(target, Boolean(body.reveal));
      const r = await runCmd(opener.command, opener.args, 8000);
      sendJson(res, r.exitCode === 0 ? 200 : 500, {
        ok: r.exitCode === 0,
        target,
        mode: how.mode,
        fromRemote,
        error: r.exitCode === 0 ? undefined : (r.stderr.trim() || 'open 失败'),
      });
      return;
    }

    // API: file pasted / dropped into the DockTerm composer -> written straight to the node
    if (req.method === 'POST' && u.pathname === '/api/chat-upload') {
      const node = getNodeById(u.searchParams.get('nodeId') || '');
      const cwd = String(u.searchParams.get('cwd') || '').trim();
      const size = Number(req.headers['content-length'] || 0);
      if (!node || !node.sshHost || !cwd.startsWith('/')) {
        req.resume();
        sendJson(res, 400, { ok: false, error: '缺少节点或工作目录' });
        return;
      }
      if (!size || size > CHAT_UPLOAD_MAX_BYTES) {
        req.resume();
        sendJson(res, 413, { ok: false, error: size ? `文件超过 ${formatByteSize(CHAT_UPLOAD_MAX_BYTES)}` : '空文件' });
        return;
      }
      const r = await uploadChatAttachment(node, cwd, u.searchParams.get('name') || 'file', req, size);
      sendJson(res, r.ok ? 200 : 500, r);
      return;
    }

    // API: Claude usage (5h / weekly) + model list + configured model/effort for a node
    if (req.method === 'GET' && u.pathname === '/api/claude-meta') {
      const data = await fetchClaudeMeta({
        nodeId: u.searchParams.get('nodeId') || '',
        cwd: u.searchParams.get('cwd') || '',
        parts: u.searchParams.get('parts') || '',
        force: u.searchParams.get('force') === '1',
      });
      sendJson(res, 200, data);
      return;
    }

    // API: Reveal in macOS Finder
    if (req.method === 'POST' && u.pathname === '/api/open-finder') {
      const body = await readJsonBody(req);
      const { localPath, node } = resolveAnyFilePathToLocalAndRemote(body.path || '', body.cwd || '', body.nodeId || '');
      const fallbackDir = (node && node.localWorkDir) || LOCAL_WORK_DIR;
      const target = (localPath && fs.existsSync(localPath)) ? localPath : fallbackDir;
      const opener = platform.openTarget(target, true);
      await runCmd(opener.command, opener.args, 3000);
      sendJson(res, 200, { ok: true, target });
      return;
    }

    // API: Move / Reorganize file or folder via Drag & Drop in Right File Tree (Mac Local Disk)
    if (req.method === 'POST' && u.pathname === '/api/files/move') {
      const body = await readJsonBody(req);
      const cwd = String(body.cwd || '').trim();
      const nodeId = String(body.nodeId || '').trim();
      const srcInfo = resolveAnyFilePathToLocalAndRemote(body.sourcePath || '', cwd, nodeId);
      const dstDirInfo = resolveAnyFilePathToLocalAndRemote(body.targetDirPath || cwd, cwd, nodeId);
      if (!srcInfo.localPath || !dstDirInfo.localPath || !platform.contains(BASE_TAKT_DIR, srcInfo.localPath) || !platform.contains(BASE_TAKT_DIR, dstDirInfo.localPath)) {
        sendJson(res, 400, { ok: false, error: '非法路径：仅允许在本地工作区内拖拽移动' });
        return;
      }
      const baseName = path.basename(srcInfo.localPath);
      const newLocalPath = path.join(dstDirInfo.localPath, baseName);
      if (newLocalPath === srcInfo.localPath || newLocalPath.startsWith(srcInfo.localPath + path.sep)) {
        sendJson(res, 400, { ok: false, error: '不能将目录移动到其自身或子目录中' });
        return;
      }
      if (!fs.existsSync(srcInfo.localPath)) {
        sendJson(res, 404, { ok: false, error: '源路径不存在' });
        return;
      }
      await fsp.mkdir(path.dirname(newLocalPath), { recursive: true });
      await fsp.rename(srcInfo.localPath, newLocalPath);
      sendJson(res, 200, { ok: true, from: srcInfo.localPath, to: newLocalPath });
      return;
    }

    // API: Upload file(s) dropped from macOS Finder into Right File Tree (Mac Local Disk)
    if (req.method === 'POST' && u.pathname === '/api/files/upload') {
      const body = await readJsonBody(req);
      const cwd = String(body.cwd || '').trim();
      const nodeId = String(body.nodeId || '').trim();
      const dstDirInfo = resolveAnyFilePathToLocalAndRemote(body.targetDirPath || cwd, cwd, nodeId);
      const fileName = path.basename(String(body.fileName || '').trim());
      const contentBase64 = String(body.contentBase64 || '');
      if (!fileName || !dstDirInfo.localPath || !platform.contains(BASE_TAKT_DIR, dstDirInfo.localPath)) {
        sendJson(res, 400, { ok: false, error: '无效的文件名或目标目录' });
        return;
      }
      await fsp.mkdir(dstDirInfo.localPath, { recursive: true });
      const dstFileLocal = path.join(dstDirInfo.localPath, fileName);
      const buf = Buffer.from(contentBase64, 'base64');
      await fsp.writeFile(dstFileLocal, buf);
      sendJson(res, 200, { ok: true, path: dstFileLocal, size: buf.length });
      return;
    }

    // API: Create subfolder inside Right File Tree (Mac Local Disk)
    if (req.method === 'POST' && u.pathname === '/api/files/mkdir') {
      const body = await readJsonBody(req);
      const cwd = String(body.cwd || '').trim();
      const nodeId = String(body.nodeId || '').trim();
      const parentInfo = resolveAnyFilePathToLocalAndRemote(body.parentDirPath || cwd, cwd, nodeId);
      const folderName = path.basename(String(body.name || '').trim());
      if (!folderName || !parentInfo.localPath || !platform.contains(BASE_TAKT_DIR, parentInfo.localPath)) {
        sendJson(res, 400, { ok: false, error: '目录名不能为空' });
        return;
      }
      const newLocal = path.join(parentInfo.localPath, folderName);
      await fsp.mkdir(newLocal, { recursive: true });
      sendJson(res, 200, { ok: true, path: newLocal });
      return;
    }

    // API: Pop out active session in macOS native Terminal.app (attached to the same remote tmux session & Linux host)
    if (req.method === 'POST' && u.pathname === '/api/open-system-terminal') {
      const body = await readJsonBody(req);
      const tabId = String(body.tabId || 'default').trim();
      const cwd = String(body.cwd || '/root/work').trim();
      const node = getNodeById(body.nodeId || body.sshHost);
      const sshHost = String(body.sshHost || node.sshHost || '').trim();
      if (platform.isWindows) {
        const command = `& ${platform.psQuote(process.execPath)} ${platform.psQuote(path.join(cfg.REPO_ROOT, 'scripts/ssh-session.js'))} ${platform.psQuote(tabId)} ${platform.psQuote(cwd)} ${platform.psQuote(sshHost)}`;
        const args = ['-NoExit', ...platform.psArgs(command)];
        const script = `Start-Process -FilePath ${platform.psQuote(platform.powershell)} -ArgumentList @(${args.map(platform.psQuote).join(',')})`;
        const result = await runCmd(platform.powershell, platform.psArgs(script), 5000);
        sendJson(res, result.exitCode === 0 ? 200 : 500, { ok: result.exitCode === 0 });
        return;
      }
      const launcherScript = path.join(__dirname, 'native-ssh-session.sh');
      const cmdStr = `/bin/bash ${shSingleQuote(launcherScript)} ${shSingleQuote(tabId)} ${shSingleQuote(cwd)} ${shSingleQuote(sshHost)}`;
      const osa = `tell application "Terminal"
        activate
        do script ${JSON.stringify(cmdStr)}
      end tell`;
      await runCmd('osascript', ['-e', osa], 4000);
      sendJson(res, 200, { ok: true });
      return;
    }

    // API: DockTerm Chat Mode — Fetch Parsed Claude Conversation (.jsonl) + Live Tmux Screen Status & Ask Prompts
    if (req.method === 'GET' && u.pathname === '/api/chat-view') {
      const tabId = String(u.searchParams.get('tabId') || '').trim();
      const sessionId = String(u.searchParams.get('sessionId') || tabId).trim();
      const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const sshHost = String(u.searchParams.get('sshHost') || '').trim();
      const epoch = String(u.searchParams.get('epoch') || '').trim();
      const ver = Number(u.searchParams.get('ver') || 0);
      const data = await fetchDocktermChatView({ tabId, sessionId, cwd, nodeId, sshHost, epoch, ver });
      sendJson(res, 200, data);
      return;
    }

    // API: DockTerm Chat Mode — page in older transcript history ("加载更早的消息")
    if (req.method === 'GET' && u.pathname === '/api/chat-history') {
      const tabId = String(u.searchParams.get('tabId') || '').trim();
      const sessionId = String(u.searchParams.get('sessionId') || tabId).trim();
      const nodeId = String(u.searchParams.get('nodeId') || '').trim();
      const sshHost = String(u.searchParams.get('sshHost') || '').trim();
      const epoch = String(u.searchParams.get('epoch') || '').trim();
      const data = await fetchDocktermHistory({ tabId, sessionId, nodeId, sshHost, epoch });
      sendJson(res, 200, data);
      return;
    }

    // API: DockTerm Chat Mode — Send Input / Keys to Remote Tmux Session (Fallback when Native/Web PTY not directly used)
    if (req.method === 'POST' && u.pathname === '/api/chat-input') {
      const body = await readJsonBody(req);
      const tabId = String(body.tabId || '').trim();
      const text = typeof body.text === 'string' ? body.text : '';
      const submitEnter = Boolean(body.submitEnter);
      // Enter must arrive after Claude Code has finished ingesting the text, otherwise it is
      // swallowed as part of the paste and the message is never submitted.
      const enterDelayMs = Math.max(60, Math.min(1500, Number(body.enterDelayMs) || (90 + Math.ceil(text.length / 20))));
      const node = getNodeById(body.nodeId || body.sshHost);
      const targetHost = String(body.sshHost || (node && node.sshHost) || '').trim();
      const tmuxSess = sanitizeTmuxSessionId(tabId || 'default');

      // Bracketed-paste payloads go through a tmux buffer (paste-buffer -p re-wraps them only if the app asked for it)
      const PASTE_START = '\x1b[200~';
      const PASTE_END = '\x1b[201~';
      const isPaste = text.startsWith(PASTE_START) && text.endsWith(PASTE_END);

      // A submitted paste always goes through tmux on the node: Enter has to wait until Claude Code
      // has finished the paste, and only the pane shows that ("Pasting…" in its footer)
      const localTab = activePtyTabs.get(tabId);
      if (localTab && !localTab.exited && !(isPaste && submitEnter)) {
        if (text) localTab.ptyProc.write(text);
        if (submitEnter) {
          setTimeout(() => {
            try { localTab.ptyProc.write('\r'); } catch {}
          }, enterDelayMs);
        }
        sendJson(res, 200, { ok: true, via: 'pty' });
        return;
      }

      const body64 = Buffer.from(isPaste ? text.slice(PASTE_START.length, -PASTE_END.length) : text, 'utf8').toString('base64');
      // While Claude Code shows "Pasting…" it swallows Enter, and after a paste with image paths
      // in it that Enter is dropped (= the message is never sent). So wait for the footer to clear;
      // if it never does (e.g. a clipboard helper on the node that hangs), leave Enter out and report it.
      const PASTE_WAIT_S = 8;
      const py = `
import base64, json, subprocess, time
sess = "=" + ${JSON.stringify(tmuxSess)} + ":"
raw = base64.b64decode(${JSON.stringify(body64)}).decode("utf-8", errors="ignore")
is_paste = ${isPaste ? 'True' : 'False'}
def pasting():
    try:
        r = subprocess.run(["tmux", "capture-pane", "-p", "-t", sess], capture_output=True, text=True, timeout=2)
    except Exception:
        return False
    tail = [l.strip() for l in r.stdout.splitlines() if l.strip()][-4:]
    return any(l.startswith("Pasting\\u2026") or l.startswith("Pasting...") for l in tail)
if raw:
    if is_paste:
        subprocess.run(["tmux", "set-buffer", "-b", "takt_dockterm", "--", raw], timeout=2)
        subprocess.run(["tmux", "paste-buffer", "-p", "-d", "-b", "takt_dockterm", "-t", sess], timeout=2)
    else:
        subprocess.run(["tmux", "send-keys", "-t", sess, "-l", "--", raw], timeout=2)
stuck = False
waited = 0.0
if ${submitEnter ? 'True' : 'False'}:
    time.sleep(${(enterDelayMs / 1000).toFixed(3)})
    if is_paste and raw:
        t0 = time.time()
        while pasting():
            if time.time() - t0 > ${PASTE_WAIT_S}:
                stuck = True
                break
            time.sleep(0.12)
        waited = time.time() - t0
        if not stuck and waited > 0.2:
            time.sleep(0.15)
    if not stuck:
        subprocess.run(["tmux", "send-keys", "-t", sess, "Enter"], timeout=2)
print(json.dumps({"stuck": stuck, "waited": round(waited, 2)}))
`.trim();
      const pyB64 = Buffer.from(py, 'utf8').toString('base64');
      const r = await runCmd('ssh', [
        ...DOCKTERM_SSH_OPTS,
        targetHost,
        `python3 -c "import base64;exec(base64.b64decode('${pyB64}'))"`,
      ], 4500 + enterDelayMs + (isPaste && submitEnter ? PASTE_WAIT_S * 1000 + 1500 : 0));
      let info = {};
      try { info = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || '{}'); } catch {}
      sendJson(res, 200, { ok: r.exitCode === 0 && !info.stuck, via: 'tmux', stuck: Boolean(info.stuck), waited: info.waited || 0 });
      return;
    }

    // API: Bottom Status Bar
    if (req.method === 'GET' && u.pathname === '/api/status') {
      const st = await getCombinedSystemStatus();
      sendJson(res, 200, st);
      return;
    }

    // API: One-click Heal SSH Tunnel + MCP + Syncthing across all enabled nodes
    if (req.method === 'POST' && u.pathname === '/api/heal') {
      try {
        await mcpFetch('/system-heal', { method: 'POST' });
      } catch {
        await ensureMacMcpDaemonRunning();
      }
      const st = await getCombinedSystemStatus();
      sendJson(res, 200, st);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

// WebSocket Server for Multi-Tab Persistent Terminal Sessions
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (!isLoopbackHost(req.headers.host) || (req.headers.origin && !isSameLocalOrigin(req.headers.origin))) {
    socket.destroy();
    return;
  }
  if (u.pathname === '/ws/term') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, u);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, _req, u) => {
  const tabId = String(u.searchParams.get('tabId') || '').trim() || crypto.randomUUID();
  const sessionId = String(u.searchParams.get('sessionId') || tabId).trim();
  const cwd = String(u.searchParams.get('cwd') || '/root/work').trim();
  const nodeId = String(u.searchParams.get('nodeId') || '').trim();
  const sshHost = String(u.searchParams.get('sshHost') || '').trim();
  const title = String(u.searchParams.get('title') || '').trim();
  const resume = u.searchParams.get('resume') !== '0';
  const mode = String(u.searchParams.get('mode') || 'claude').trim();
  const cols = Number(u.searchParams.get('cols') || 120);
  const rows = Number(u.searchParams.get('rows') || 36);

  let tab;
  try { tab = getOrCreatePtyTab({ tabId, sessionId, title, cwd, resume, mode, nodeId, sshHost }); }
  catch (error) { ws.send(JSON.stringify({ type: 'error', error: error.message })); ws.close(1008, 'Invalid terminal node'); return; }
  tab.clients.add(ws);

  try {
    if (cols > 10 && rows > 5) {
      tab.ptyProc.resize(cols, rows);
    }
  } catch {}

  if (tab.scrollback.length > 0) {
    try {
      ws.send(JSON.stringify({
        type: 'output',
        tabId: tab.tabId,
        data: tab.scrollback.join(''),
      }));
    } catch {}
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input' && typeof msg.data === 'string') {
        tab.ptyProc.write(msg.data);
      } else if (msg.type === 'resize' && msg.cols > 10 && msg.rows > 4) {
        tab.ptyProc.resize(Number(msg.cols), Number(msg.rows));
      } else if (msg.type === 'kill') {
        closePtyTab(tab.tabId, tab.nodeId);
      }
    } catch {}
  });

  ws.on('close', () => {
    tab.clients.delete(ws);
  });
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const tab of activePtyTabs.values()) { try { tab.ptyProc.kill(); } catch {} }
  for (const client of wss.clients) client.terminate();
  server.close();
  setTimeout(() => process.exit(0), platform.isWindows ? 3500 : 300);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  const logLine = `[${new Date().toISOString()}] TAKT Multi-Node Workbench listening on ${url}\n`;
  try {
    fs.writeFileSync(DSH_WEB_LOG, logLine, 'utf8');
  } catch {}
  console.log(logLine.trim());
});
