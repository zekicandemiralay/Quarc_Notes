// Page persistence shared by the REST routes (routes/pages.js) and offline
// sync (routes/sync.js), so both enforce the same rules: ownership, valid
// parents (no cycles, no other user's pages), cascading trash/restore,
// tombstones for permanent deletes, and keeping search + links in step.

const { v4: uuidv4 } = require('uuid');
const { NOW, DEFAULT_CANVAS_SETTINGS } = require('../db');
const { extractText, extractCanvasText, extractWikilinkIds, mergeScenes } = require('./content');

const MAX_TITLE = 500;
const MAX_ICON = 32;

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Row -> API shape (JSON columns parsed).
function serialize(page) {
  if (!page) return page;
  return {
    ...page,
    content_json: parseJson(page.content_json, []),
    ink_json: parseJson(page.ink_json, []),
    canvas_settings: parseJson(page.canvas_settings, parseJson(DEFAULT_CANVAS_SETTINGS, {})),
    is_favorite: page.is_favorite ? 1 : 0,
  };
}

// Accepts the server's own format or an ISO string from an older client.
function normalizeTs(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.replace('T', ' ').replace(/Z$/, '').replace(/[+-]\d\d:\d\d$/, '');
}

function nowTs(db) {
  return db.prepare(`SELECT ${NOW} AS t`).get().t;
}

function getOwned(db, userId, id) {
  return db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(id, userId);
}

function reindex(db, page) {
  db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(page.id);
  const body =
    page.type === 'canvas'
      ? extractCanvasText(parseJson(page.ink_json, {}))
      : extractText(parseJson(page.content_json, []));
  db.prepare('INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)').run(page.id, page.title || '', body);
}

function syncLinks(db, page) {
  db.prepare('DELETE FROM links WHERE source_page_id = ?').run(page.id);
  if (page.type === 'canvas') return;
  const targets = extractWikilinkIds(parseJson(page.content_json, []));
  // Only link to this user's own, existing pages (a stale id from a page
  // deleted forever would otherwise violate the foreign key).
  const exists = db.prepare('SELECT 1 FROM pages WHERE id = ? AND user_id = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO links (source_page_id, target_page_id) VALUES (?, ?)');
  for (const targetId of targets) {
    if (targetId !== page.id && exists.get(targetId, page.user_id)) insert.run(page.id, targetId);
  }
}

function descendantIds(db, id) {
  return db
    .prepare(
      `WITH RECURSIVE d(id) AS (
         SELECT id FROM pages WHERE id = ?
         UNION ALL
         SELECT p.id FROM pages p JOIN d ON p.parent_id = d.id
       ) SELECT id FROM d`
    )
    .all(id)
    .map((r) => r.id);
}

// A parent must be one of the user's own pages and must not be the page
// itself or one of its own descendants (that would detach a loop of pages
// from the tree). Returns true if `parentId` is acceptable for `pageId`.
function isValidParent(db, userId, pageId, parentId) {
  if (parentId === null || parentId === undefined) return true;
  if (typeof parentId !== 'string') return false;
  if (!getOwned(db, userId, parentId)) return false;
  if (!pageId) return true;
  if (parentId === pageId) return false;
  return !descendantIds(db, pageId).includes(parentId);
}

function softDeleteTree(db, userId, id) {
  const ids = descendantIds(db, id);
  const stmt = db.prepare(`UPDATE pages SET is_deleted = 1, updated_at = ${NOW} WHERE id = ? AND user_id = ?`);
  for (const pid of ids) stmt.run(pid, userId);
  return ids;
}

// Restores a page together with everything that was trashed under it. If its
// parent is still in the trash, the page moves to the top level instead of
// staying invisible under a hidden parent.
function restoreTree(db, userId, id) {
  const page = getOwned(db, userId, id);
  if (!page) return [];
  if (page.parent_id) {
    const parent = getOwned(db, userId, page.parent_id);
    if (!parent || parent.is_deleted) {
      db.prepare(`UPDATE pages SET parent_id = NULL WHERE id = ?`).run(id);
    }
  }
  const ids = descendantIds(db, id);
  const stmt = db.prepare(`UPDATE pages SET is_deleted = 0, updated_at = ${NOW} WHERE id = ? AND user_id = ?`);
  for (const pid of ids) stmt.run(pid, userId);
  return ids;
}

function purgeTree(db, userId, id) {
  const ids = descendantIds(db, id);
  const ts = nowTs(db);
  const tomb = db.prepare('INSERT OR REPLACE INTO deleted_pages (id, user_id, deleted_at) VALUES (?, ?, ?)');
  const fts = db.prepare('DELETE FROM pages_fts WHERE page_id = ?');
  for (const pid of ids) {
    tomb.run(pid, userId, ts);
    fts.run(pid);
  }
  // ON DELETE CASCADE removes descendants, links, tags and attachment rows.
  db.prepare('DELETE FROM pages WHERE id = ? AND user_id = ?').run(id, userId);
  return ids;
}

function isTombstoned(db, userId, id) {
  return !!db.prepare('SELECT 1 FROM deleted_pages WHERE id = ? AND user_id = ?').get(id, userId);
}

// Validates/cleans incoming field values. Unknown fields are dropped.
function cleanFields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  if (typeof fields.title === 'string') out.title = fields.title.slice(0, MAX_TITLE);
  if (fields.icon === null || typeof fields.icon === 'string') out.icon = fields.icon ? fields.icon.slice(0, MAX_ICON) : null;
  if (fields.type === 'doc' || fields.type === 'canvas') out.type = fields.type;
  if (fields.content_json !== undefined && fields.content_json !== null && typeof fields.content_json === 'object') {
    out.content_json = fields.content_json;
  }
  if (fields.ink_json !== undefined && fields.ink_json !== null && typeof fields.ink_json === 'object') {
    out.ink_json = fields.ink_json;
  }
  if (fields.parent_id === null || typeof fields.parent_id === 'string') out.parent_id = fields.parent_id || null;
  if (typeof fields.sort_order === 'number' && Number.isFinite(fields.sort_order)) out.sort_order = fields.sort_order;
  if (fields.canvas_settings && typeof fields.canvas_settings === 'object' && !Array.isArray(fields.canvas_settings)) {
    out.canvas_settings = fields.canvas_settings;
  }
  if (fields.is_favorite !== undefined) out.is_favorite = fields.is_favorite ? 1 : 0;
  return out;
}

function insertPage(db, userId, id, fields, clientId) {
  const parentId = isValidParent(db, userId, null, fields.parent_id) ? fields.parent_id || null : null;
  let sortOrder = fields.sort_order;
  if (sortOrder === undefined) {
    sortOrder =
      db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM pages WHERE user_id = ? AND parent_id IS ?')
        .get(userId, parentId).m + 1;
  }
  db.prepare(
    `INSERT INTO pages (id, user_id, parent_id, title, icon, type, content_json, ink_json, sort_order,
       canvas_settings, is_favorite, created_at, updated_at, content_updated_at, last_client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW}, ${NOW}, ${NOW}, ?)`
  ).run(
    id,
    userId,
    parentId,
    fields.title ?? 'Untitled',
    fields.icon ?? null,
    fields.type || 'doc',
    JSON.stringify(fields.content_json ?? []),
    JSON.stringify(fields.ink_json ?? []),
    sortOrder,
    JSON.stringify(fields.canvas_settings ?? JSON.parse(DEFAULT_CANVAS_SETTINGS)),
    fields.is_favorite ?? 0,
    clientId || null
  );
  const page = getOwned(db, userId, id);
  reindex(db, page);
  syncLinks(db, page);
  return page;
}

// Applies a field patch to an existing page. Returns the updated row.
function updatePageFields(db, userId, current, fields, clientId) {
  const sets = [];
  const values = [];
  const set = (col, val) => {
    sets.push(`${col} = ?`);
    values.push(val);
  };
  if (fields.title !== undefined) set('title', fields.title);
  if (fields.icon !== undefined) set('icon', fields.icon);
  if (fields.parent_id !== undefined && isValidParent(db, userId, current.id, fields.parent_id)) {
    set('parent_id', fields.parent_id);
  }
  if (fields.sort_order !== undefined) set('sort_order', fields.sort_order);
  if (fields.canvas_settings !== undefined) set('canvas_settings', JSON.stringify(fields.canvas_settings));
  if (fields.is_favorite !== undefined) set('is_favorite', fields.is_favorite);
  let contentChanged = false;
  if (fields.content_json !== undefined) {
    const json = JSON.stringify(fields.content_json);
    if (json !== current.content_json) {
      set('content_json', json);
      contentChanged = true;
    }
  }
  if (fields.ink_json !== undefined) {
    const json = JSON.stringify(fields.ink_json);
    if (json !== current.ink_json) {
      set('ink_json', json);
      contentChanged = true;
    }
  }
  if (contentChanged) {
    sets.push(`content_updated_at = ${NOW}`);
    set('last_client_id', clientId || null);
  }
  if (!sets.length) return current;
  sets.push(`updated_at = ${NOW}`);
  db.prepare(`UPDATE pages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...values, current.id, userId);
  const page = getOwned(db, userId, current.id);
  reindex(db, page);
  syncLinks(db, page);
  return page;
}

function createConflictCopy(db, current, label) {
  const id = uuidv4();
  const suffix = typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : 'conflict copy';
  db.prepare(
    `INSERT INTO pages (id, user_id, parent_id, title, icon, type, content_json, ink_json, sort_order,
       canvas_settings, is_favorite, created_at, updated_at, content_updated_at, last_client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ${NOW}, ${NOW}, ${NOW}, ?)`
  ).run(
    id,
    current.user_id,
    current.parent_id,
    `${current.title || 'Untitled'} (${suffix})`.slice(0, MAX_TITLE),
    current.icon,
    current.type,
    current.content_json,
    current.ink_json,
    (current.sort_order || 0) + 0.5,
    current.canvas_settings,
    current.last_client_id
  );
  const page = getOwned(db, current.user_id, id);
  reindex(db, page);
  syncLinks(db, page);
  return id;
}

// Content written by ANOTHER device after the version this edit was based
// on, and actually different from what's being written now = a genuine
// conflict. The same device's own consecutive saves never conflict, even
// when they were queued against an older base (e.g. a retry after a lost
// response, or several saves sent in one batch).
function hasContentConflict(current, field, newValue, baseTs, clientId) {
  if (!baseTs) return false;
  const changedAt = current.content_updated_at || current.updated_at;
  if (!changedAt || changedAt <= baseTs) return false;
  if (clientId && current.last_client_id === clientId) return false;
  return JSON.stringify(newValue) !== current[field];
}

module.exports = {
  parseJson,
  serialize,
  normalizeTs,
  nowTs,
  getOwned,
  reindex,
  syncLinks,
  descendantIds,
  isValidParent,
  softDeleteTree,
  restoreTree,
  purgeTree,
  isTombstoned,
  cleanFields,
  insertPage,
  updatePageFields,
  createConflictCopy,
  hasContentConflict,
  mergeScenes,
};
