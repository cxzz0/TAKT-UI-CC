'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { buildRemoteScanPy } = require('./session-scanner');
module.exports = function createSessionIndex({ cfg, database, nodeRegistry, runCmd }) {
const SESSION_TITLES_FILE = cfg.SESSION_TITLES_FILE;
const WORKBENCH_DB_FILE = cfg.DB_FILE;
const { loadNodes, saveNodes, getNodeById, ensureNodeLocalDirAndSymlink } = nodeRegistry;
const { workbenchDb, readTagsFromSqlite, stmtUpsertProject, stmtUpsertSessionFromScan, stmtRegisterLocalSession, stmtRenameSession, stmtSoftDeleteSession, stmtUpsertNodeStatus } = database;
function loadCustomSessionTitles() {
  try {
    if (fs.existsSync(SESSION_TITLES_FILE)) {
      const titles = JSON.parse(fs.readFileSync(SESSION_TITLES_FILE, 'utf8')) || {};
      for (const [id, title] of Object.entries(titles)) {
        if (id.includes('::')) continue;
        const owners = workbenchDb.prepare('SELECT node_id FROM sessions WHERE id = ?').all(id);
        // A legacy id-only title has an owner only if the database is unambiguous.
        if (owners.length === 1 && !titles[`${owners[0].node_id}::${id}`]) titles[`${owners[0].node_id}::${id}`] = title;
      }
      return titles;
    }
  } catch {}
  return {};
}

function saveCustomSessionTitle(sid, newTitle, nodeId) {
  const map = loadCustomSessionTitles();
  const key = `${nodeId}::${sid}`;
  delete map[sid];
  if (newTitle) {
    map[key] = newTitle;
  } else {
    delete map[key];
  }
  try {
    fs.writeFileSync(SESSION_TITLES_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch {}
  try {
    if (newTitle) {
      stmtRenameSession.run(newTitle, newTitle, Date.now(), nodeId, sid);
    }
  } catch {}
}

function normalizeToTopProjectPath(node, rawRemotePath) {
  const remoteRoot = ((node && node.remoteWorkDir) || '/root/work').replace(/\/+$/, '') || '/root/work';
  const clean = String(rawRemotePath || remoteRoot).replace(/\/+$/, '') || remoteRoot;
  if (clean === remoteRoot) return remoteRoot;
  if (clean.startsWith(remoteRoot + '/')) {
    const rel = clean.slice(remoteRoot.length + 1);
    const topSeg = rel.split('/')[0];
    if (topSeg) return `${remoteRoot}/${topSeg}`;
  }
  return remoteRoot;
}

function upsertProjectInSqlite(node, remotePath, name, pinnedVisible = 0) {
  const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  const cleanPath = normalizeToTopProjectPath(node, remotePath);
  const rel = cleanPath === remoteRoot
    ? ''
    : cleanPath.slice(remoteRoot.length + 1);
  const localPath = rel ? path.join(node.localWorkDir, rel) : node.localWorkDir;
  const displayName = cleanPath === remoteRoot ? `${node.localWorkAlias} (主工作区)` : path.basename(cleanPath);
  const key = `${node.id}::${cleanPath}`;
  stmtUpsertProject.run(key, node.id, cleanPath, localPath, displayName, pinnedVisible ? 1 : 0, Date.now());
  return { key, cleanPath, localPath, displayName };
}

// Titles the workbench makes up before a session has a real one
// ("会话 1a2b3c4d" from the scan, "<project> · 终端" for new tabs, "对话 …" / "终端 (…)" for pty tabs)
function isPlaceholderSessionTitle(title) {
  const t = String(title || '').trim();
  return !t || /^(会话|对话) [0-9a-f]{8}$/i.test(t) || / · 终端$/.test(t) || /^终端 \(.*\)$/.test(t);
}

function registerSessionInSqlite({ id, nodeId, cwd, title }) {
  if (!id) return;
  const node = getNodeById(nodeId);
  const cleanCwd = normalizeToTopProjectPath(node, cwd);
  upsertProjectInSqlite(node, cleanCwd, path.basename(cleanCwd), 1);
  stmtRegisterLocalSession.run(id, node.id, cleanCwd, title || `会话 ${id.slice(0, 8)}`, Date.now());
}

async function syncSingleNodeToSqlite(node, customTitles) {
  ensureNodeLocalDirAndSymlink(node);
  const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';

  // 1. Always index Mac local subdirectories into SQLite immediately
  upsertProjectInSqlite(node, remoteRoot, `${node.localWorkAlias} (主工作区)`, 0);
  try {
    const entries = await fsp.readdir(node.localWorkDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'uploads') {
        upsertProjectInSqlite(node, `${remoteRoot}/${e.name}`, e.name, 0);
      }
    }
  } catch {}

  // 2. If SSH is enabled & configured, scan remote folders & .jsonl sessions and upsert into SQLite
  if (node.enabled && node.sshHost) {
    const py = buildRemoteScanPy(remoteRoot);
    const b64 = Buffer.from(py, 'utf8').toString('base64');
    const r = await runCmd('ssh', [
      '-o', 'ConnectTimeout=4',
      '-o', 'ClearAllForwardings=yes',
      node.sshHost,
      `python3 -c "import base64;exec(base64.b64decode('${b64}'))"`,
    ], 6500);

    if (r.exitCode === 0 && r.stdout.trim()) {
      try {
        const parsed = JSON.parse(r.stdout.trim().split('\n').pop());
        if (parsed && Array.isArray(parsed.folders)) {
          if (parsed.resolvedWorkRoot && parsed.resolvedWorkRoot !== node.remoteWorkDir) {
            const oldRoot = node.remoteWorkDir;
            node.remoteWorkDir = parsed.resolvedWorkRoot;
            const allNodes = loadNodes();
            const target = allNodes.find((x) => x.id === node.id);
            if (target) {
              target.remoteWorkDir = parsed.resolvedWorkRoot;
              saveNodes(allNodes);
            }
            try {
              workbenchDb.prepare('DELETE FROM projects WHERE key = ?').run(`${node.id}::${oldRoot}`);
            } catch {}
          }
          const now = Date.now();
          workbenchDb.exec('BEGIN IMMEDIATE');
          try {
            for (const f of parsed.folders) {
              const fPath = normalizeToTopProjectPath(node, f.path);
              upsertProjectInSqlite(node, fPath, f.name, 0);
              for (const s of (f.sessions || [])) {
                const customTitle = customTitles[`${node.id}::${s.id}`] || ''; 
                const finalTitle = customTitle || s.title || `会话 ${String(s.id).slice(0, 8)}`;
                stmtUpsertSessionFromScan.run(
                  s.id,
                  node.id,
                  fPath,
                  finalTitle,
                  customTitle,
                  s.lastPrompt || '',
                  Number(s.turns || 1),
                  Number(s.sizeBytes || 0),
                  Number(s.updatedAt || now)
                );
              }
            }
            stmtUpsertNodeStatus.run(node.id, 1, now);
            workbenchDb.exec('COMMIT');
          } catch (txErr) {
            try { workbenchDb.exec('ROLLBACK'); } catch {}
            throw txErr;
          }
          return true;
        }
      } catch {}
    }
    // Note: on SSH timeout/failure, we ONLY mark online=0; we NEVER delete or clear existing projects/sessions in SQLite!
    stmtUpsertNodeStatus.run(node.id, 0, 0);
    return false;
  }

  stmtUpsertNodeStatus.run(node.id, 0, 0);
  return false;
}

let sqliteSyncInFlight = null;
let lastSqliteSyncAt = 0;

async function syncAllNodesToSqlite() {
  if (sqliteSyncInFlight) return sqliteSyncInFlight;
  sqliteSyncInFlight = (async () => {
    try {
      const customTitles = loadCustomSessionTitles();
      const nodes = loadNodes();
      await Promise.all(nodes.map((n) => syncSingleNodeToSqlite(n, customTitles)));
      lastSqliteSyncAt = Date.now();
    } catch {} finally {
      sqliteSyncInFlight = null;
    }
  })();
  return sqliteSyncInFlight;
}

function readTreeFromSqlite() {
  const nodes = loadNodes();
  const statusRows = workbenchDb.prepare('SELECT node_id, online, last_sync_at FROM node_status').all();
  const statusMap = new Map(statusRows.map((r) => [r.node_id, r]));

  // Ensure every node's local root & subdirs are present in SQLite
  for (const n of nodes) {
    ensureNodeLocalDirAndSymlink(n);
    const remoteRoot = (n.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
    upsertProjectInSqlite(n, remoteRoot, `${n.localWorkAlias} (主工作区)`, 0);
    try {
      const entries = fs.readdirSync(n.localWorkDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'uploads') {
          upsertProjectInSqlite(n, `${remoteRoot}/${e.name}`, e.name, 0);
        }
      }
    } catch {}
  }

  const projectRows = workbenchDb.prepare(`
    SELECT key, node_id, path, local_path, name, pinned_visible, updated_at
    FROM projects
    WHERE deleted = 0
  `).all();

  const sessionRows = workbenchDb.prepare(`
    SELECT id, node_id, project_path, title, custom_title, last_prompt, turns, size_bytes, updated_at
    FROM sessions
    WHERE deleted = 0
    ORDER BY updated_at DESC
  `).all();

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const foldersByKey = new Map();

  for (const p of projectRows) {
    const node = nodeMap.get(p.node_id);
    if (!node) continue;
    const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
    const st = statusMap.get(node.id);
    foldersByKey.set(p.key, {
      key: p.key,
      path: p.path,
      localPath: p.local_path,
      name: p.path === remoteRoot ? `${node.localWorkAlias} (主工作区)` : p.name,
      nodeId: node.id,
      nodeName: node.name,
      nodeBadge: node.badge,
      sshHost: node.sshHost || '',
      remoteWorkDir: remoteRoot,
      localWorkDir: node.localWorkDir,
      localWorkAlias: node.localWorkAlias,
      pinnedVisible: Boolean(p.pinned_visible),
      online: st ? Boolean(st.online) : false,
      sessions: [],
    });
  }

  for (const s of sessionRows) {
    const node = nodeMap.get(s.node_id);
    if (!node) continue;
    // Never-used sessions only carry a placeholder title: keep them out of the sidebar
    // (they show up as soon as the first prompt gives them a real title)
    if (!s.custom_title && isPlaceholderSessionTitle(s.title)) continue;
    const remoteRoot = (node.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
    const fKey = `${node.id}::${s.project_path}`;
    if (!foldersByKey.has(fKey)) {
      const info = upsertProjectInSqlite(node, s.project_path, path.basename(s.project_path), 0);
      const st = statusMap.get(node.id);
      foldersByKey.set(fKey, {
        key: fKey,
        path: info.cleanPath,
        localPath: info.localPath,
        name: info.displayName,
        nodeId: node.id,
        nodeName: node.name,
        nodeBadge: node.badge,
        sshHost: node.sshHost || '',
        remoteWorkDir: remoteRoot,
        localWorkDir: node.localWorkDir,
        localWorkAlias: node.localWorkAlias,
        pinnedVisible: false,
        online: st ? Boolean(st.online) : false,
        sessions: [],
      });
    }
    const folder = foldersByKey.get(fKey);
    folder.sessions.push({
      id: s.id,
      title: s.custom_title || s.title,
      lastPrompt: s.last_prompt,
      cwd: s.project_path,
      updatedAt: s.updated_at,
      sizeBytes: s.size_bytes,
      turns: s.turns,
      existsOnDisk: true,
      nodeId: node.id,
      nodeName: node.name,
      nodeBadge: node.badge,
      sshHost: node.sshHost || '',
      localWorkDir: node.localWorkDir,
      localWorkAlias: node.localWorkAlias,
      localPath: folder.localPath,
    });
  }

  const allFolders = [];
  const nodeStates = nodes.map((n) => {
    const remoteRoot = (n.remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
    const nodeFolders = Array.from(foldersByKey.values())
      .filter((f) => f.nodeId === n.id)
      .sort((a, b) => {
        if (a.path === remoteRoot && b.path !== remoteRoot) return -1;
        if (b.path === remoteRoot && a.path !== remoteRoot) return 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
    for (const f of nodeFolders) allFolders.push(f);
    const st = statusMap.get(n.id);
    return {
      ...n,
      online: st ? Boolean(st.online) : false,
      lastSyncAt: st ? st.last_sync_at : 0,
      projectCount: nodeFolders.length,
      sessionCount: nodeFolders.reduce((acc, f) => acc + f.sessions.length, 0),
    };
  });

  return {
    ok: true,
    source: 'sqlite',
    dbPath: WORKBENCH_DB_FILE,
    nodes: nodeStates,
    folders: allFolders,
  };
}


return { loadCustomSessionTitles, saveCustomSessionTitle, normalizeToTopProjectPath, upsertProjectInSqlite, isPlaceholderSessionTitle, registerSessionInSqlite, syncAllNodesToSqlite, readTreeFromSqlite, getLastSyncAt: () => lastSqliteSyncAt };
};
