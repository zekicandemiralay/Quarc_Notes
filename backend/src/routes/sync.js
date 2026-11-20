const express = require('express');
const router = express.Router();
const { getDb, NOW } = require('../db');
const store = require('../services/pageStore');

// Pull: everything for this user updated since `since` (the serverTime the
// client got from its previous pull), so it can refresh its offline cache.
//
// v=2 clients use an inclusive bound (they skip versions they already have,
// so re-receiving the boundary is harmless and nothing written in the same
// millisecond as the cursor can slip through) and also receive the ids of
// pages deleted forever since then. Older app versions (no `v`) keep the
// exact behavior they were built against.
router.get('/pull', (req, res) => {
  const db = getDb();
  const v2 = req.query.v === '2';
  const since = store.normalizeTs(req.query.since) || '1970-01-01 00:00:00';
  const serverTime = db.prepare(`SELECT ${NOW} AS t`).get().t;
  const pages = db
    .prepare(`SELECT * FROM pages WHERE user_id = ? AND updated_at ${v2 ? '>=' : '>'} ? ORDER BY updated_at ASC`)
    .all(req.user.id, since);

  const body = { serverTime, pages: pages.map(store.serialize) };
  if (v2) {
    body.deleted = db
      .prepare('SELECT id FROM deleted_pages WHERE user_id = ? AND deleted_at >= ?')
      .all(req.user.id, since)
      .map((r) => r.id);
  }
  res.json(body);
});

// Older app versions send whole-page snapshots: { op: 'upsert'|'delete', id,
// title, icon, type, content_json, ink_json, parent_id, sort_order,
// canvas_settings, base_updated_at }. Translate to the v2 shape.
function fromLegacy(m) {
  if (m.op === 'delete') return { id: m.id, deleted: true };
  const fields = {};
  for (const key of ['title', 'icon', 'type', 'content_json', 'ink_json', 'parent_id', 'sort_order', 'canvas_settings']) {
    if (m[key] !== undefined) fields[key] = m[key];
  }
  return { id: m.id, base_updated_at: m.base_updated_at, fields };
}

// Applies one mutation. v2 shape:
//   { id, base_updated_at?, fields?: {...changed fields}, deleted?: bool, purge?: bool }
// `fields` holds only what changed on the device, so concurrent edits of
// different things (a rename here, writing there) both survive. Content
// conflicts — another device changed the same page's content since this
// edit's base — never lose data: drawings merge stroke by stroke, documents
// keep the other device's version as a "conflict copy" page next to it.
function applyMutation(db, userId, clientId, conflictLabel, raw, opts) {
  const m = raw && (raw.fields || 'deleted' in raw || raw.purge) ? raw : fromLegacy(raw || {});
  if (!m.id || typeof m.id !== 'string' || m.id.length > 64) return { id: raw?.id, status: 'error', error: 'invalid id' };

  const anyRow = db.prepare('SELECT user_id FROM pages WHERE id = ?').get(m.id);
  if (anyRow && anyRow.user_id !== userId) return { id: m.id, status: 'error', error: 'forbidden' };

  if (m.purge) {
    if (anyRow) store.purgeTree(db, userId, m.id);
    return { id: m.id, status: 'ok', purged: true };
  }

  const fields = store.cleanFields(m.fields);
  let current = store.getOwned(db, userId, m.id);
  let writer = clientId;
  const result = { id: m.id, status: 'ok' };

  if (!current) {
    if (store.isTombstoned(db, userId, m.id)) return { id: m.id, status: 'gone' };
    // Trashing/restoring a page the server never received: nothing to do.
    if (!Object.keys(fields).length) return { id: m.id, status: 'ok' };
    // A sub-page created offline can reach us before its parent does when
    // both are in the same batch: let the caller retry it after the rest.
    if (fields.parent_id && !store.getOwned(db, userId, fields.parent_id) && opts?.canDefer?.(fields.parent_id)) {
      return { id: m.id, status: 'defer' };
    }
    current = store.insertPage(db, userId, m.id, fields, clientId);
  } else if (Object.keys(fields).length) {
    const base = store.normalizeTs(m.base_updated_at);
    // The device built this edit on an older version than the server has
    // (or doesn't say which): send the result back so it also gets whatever
    // else changed meanwhile — it skips pulling pages it has edits queued for.
    if (!base || current.updated_at > base) result.stale = true;
    const contentField = fields.ink_json !== undefined ? 'ink_json' : fields.content_json !== undefined ? 'content_json' : null;
    if (contentField && !opts?.seen?.has(m.id) && store.hasContentConflict(current, contentField, fields[contentField], base, clientId)) {
      if (contentField === 'ink_json') {
        fields.ink_json = store.mergeScenes(store.parseJson(current.ink_json, null), fields.ink_json);
        result.merged = true;
        // The merged drawing is nobody's own write: if this device sends
        // another edit built on its pre-merge copy, that must merge again
        // rather than count as its own follow-up save and drop the strokes
        // merged in from the other device.
        writer = null;
      } else {
        result.conflict_copy_id = store.createConflictCopy(db, current, conflictLabel);
      }
    }
    current = store.updatePageFields(db, userId, current, fields, writer);
  }

  if (m.deleted === true && !current.is_deleted) store.softDeleteTree(db, userId, m.id);
  if (m.deleted === false && current.is_deleted) store.restoreTree(db, userId, m.id);

  current = store.getOwned(db, userId, m.id);
  result.updated_at = current.updated_at;
  // The server's copy now differs from what the device sent (merged
  // strokes, or a restore that moved it): send it back so the device
  // doesn't have to wait for its next pull to see the result.
  if (result.merged || result.stale || m.deleted === false) result.page = store.serialize(current);
  delete result.stale;
  return result;
}

// Push: the device's queued offline edits, applied in order in a single
// transaction (all or nothing).
router.post('/push', (req, res) => {
  const db = getDb();
  const mutations = Array.isArray(req.body.mutations) ? req.body.mutations.slice(0, 500) : [];
  const clientId = typeof req.body.client_id === 'string' ? req.body.client_id.slice(0, 64) : null;
  const conflictLabel = typeof req.body.conflict_label === 'string' ? req.body.conflict_label : null;

  const createdInBatch = new Set(mutations.map((m) => m && m.id).filter(Boolean));
  const seen = new Set();
  const results = [];

  try {
    db.transaction(() => {
      let pending = mutations;
      for (let pass = 0; pass < 3 && pending.length; pass++) {
        const deferred = [];
        for (const m of pending) {
          let r;
          try {
            r = applyMutation(db, req.user.id, clientId, conflictLabel, m, {
              seen,
              canDefer: (parentId) => pass < 2 && createdInBatch.has(parentId),
            });
          } catch (err) {
            r = { id: m?.id, status: 'error', error: err.message };
          }
          if (r.status === 'defer') deferred.push(m);
          else {
            if (r.status === 'ok') seen.add(r.id);
            results.push(r);
          }
        }
        pending = deferred;
      }
    })();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ results });
});

module.exports = router;
module.exports.applyMutation = applyMutation;
