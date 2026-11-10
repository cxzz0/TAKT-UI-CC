'use strict';
const { DatabaseSync } = require('node:sqlite');
module.exports = function openWorkbenchDb(WORKBENCH_DB_FILE) {
const workbenchDb = new DatabaseSync(WORKBENCH_DB_FILE);
workbenchDb.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS projects (
    key TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    path TEXT NOT NULL,
    local_path TEXT NOT NULL,
    name TEXT NOT NULL,
    pinned_visible INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    title TEXT NOT NULL,
    custom_title TEXT NOT NULL DEFAULT '',
    last_prompt TEXT NOT NULL DEFAULT '',
    turns INTEGER NOT NULL DEFAULT 1,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (node_id, id)
  );

  CREATE TABLE IF NOT EXISTS node_status (
    node_id TEXT PRIMARY KEY,
    online INTEGER NOT NULL DEFAULT 0,
    last_sync_at INTEGER NOT NULL DEFAULT 0
  );

  -- Project classification tags (Antigravity-style sidebar tags)
  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'blue',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS project_tags (
    project_key TEXT PRIMARY KEY,
    tag_id TEXT NOT NULL
  );
`);

// Auto-migrate legacy sessions table if primary key is not composite (node_id, id)
try {
  const cols = workbenchDb.prepare("PRAGMA table_info(sessions)").all();
  const pkCols = cols.filter((c) => Number(c.pk) > 0);
  if (pkCols.length === 1 && pkCols[0].name === 'id') {
    workbenchDb.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE sessions_v2 (
        id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        title TEXT NOT NULL,
        custom_title TEXT NOT NULL DEFAULT '',
        last_prompt TEXT NOT NULL DEFAULT '',
        turns INTEGER NOT NULL DEFAULT 1,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (node_id, id)
      );
      INSERT OR REPLACE INTO sessions_v2
        SELECT id, node_id, project_path, title, custom_title, last_prompt, turns, size_bytes, updated_at, deleted
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v2 RENAME TO sessions;
      COMMIT;
    `);
  }
} catch (error) {
  try { workbenchDb.exec('ROLLBACK'); } catch {}
  workbenchDb.close();
  throw error;
}

function readTagsFromSqlite() {
  const tags = workbenchDb.prepare('SELECT id, name, color, sort FROM tags ORDER BY sort ASC, created_at ASC').all();
  const projectTags = {};
  for (const r of workbenchDb.prepare('SELECT project_key, tag_id FROM project_tags').all()) {
    projectTags[r.project_key] = r.tag_id;
  }
  return { tags, projectTags };
}

const stmtUpsertProject = workbenchDb.prepare(`
  INSERT INTO projects (key, node_id, path, local_path, name, pinned_visible, deleted, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(key) DO UPDATE SET
    local_path = excluded.local_path,
    name = excluded.name,
    pinned_visible = MAX(projects.pinned_visible, excluded.pinned_visible),
    deleted = 0,
    updated_at = excluded.updated_at
`);

const stmtUpsertSessionFromScan = workbenchDb.prepare(`
  INSERT INTO sessions (id, node_id, project_path, title, custom_title, last_prompt, turns, size_bytes, updated_at, deleted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT(node_id, id) DO UPDATE SET
    project_path = excluded.project_path,
    title = CASE
      WHEN sessions.custom_title != '' THEN sessions.custom_title
      ELSE excluded.title
    END,
    last_prompt = CASE
      WHEN excluded.last_prompt != '' THEN excluded.last_prompt
      ELSE sessions.last_prompt
    END,
    turns = MAX(sessions.turns, excluded.turns),
    size_bytes = MAX(sessions.size_bytes, excluded.size_bytes),
    updated_at = MAX(sessions.updated_at, excluded.updated_at)
`);

const stmtRegisterLocalSession = workbenchDb.prepare(`
  INSERT INTO sessions (id, node_id, project_path, title, custom_title, last_prompt, turns, size_bytes, updated_at, deleted)
  VALUES (?, ?, ?, ?, '', '', 1, 0, ?, 0)
  ON CONFLICT(node_id, id) DO UPDATE SET
    deleted = 0,
    updated_at = MAX(sessions.updated_at, excluded.updated_at)
`);

const stmtRenameSession = workbenchDb.prepare(`
  UPDATE sessions
  SET custom_title = ?, title = ?, updated_at = ?
  WHERE node_id = ? AND id = ?
`);

const stmtSoftDeleteSession = workbenchDb.prepare(`
  UPDATE sessions
  SET deleted = 1, updated_at = ?
  WHERE node_id = ? AND id = ?
`);

const stmtUpsertNodeStatus = workbenchDb.prepare(`
  INSERT INTO node_status (node_id, online, last_sync_at)
  VALUES (?, ?, ?)
  ON CONFLICT(node_id) DO UPDATE SET
    online = excluded.online,
    last_sync_at = CASE
      WHEN excluded.last_sync_at > 0 THEN excluded.last_sync_at
      ELSE node_status.last_sync_at
    END
`);


return { workbenchDb, readTagsFromSqlite, stmtUpsertProject, stmtUpsertSessionFromScan, stmtRegisterLocalSession, stmtRenameSession, stmtSoftDeleteSession, stmtUpsertNodeStatus };
};
