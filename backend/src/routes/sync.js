const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { extractText, extractWikilinkIds } = require('../services/content');

function reindexFts(db, page) {
  db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(page.id);
  db.prepare('INSERT INTO pages_fts (page_id, title, body) VALUES (?, ?, ?)')
    .run(page.id, page.title, extractText(JSON.parse(page.content_json || '[]')));
}

function syncLinks(db, page) {
  db.prepare('DELETE FROM links WHERE source_page_id = ?').run(page.id);
  const targets = extractWikilinkIds(JSON.parse(page.content_json || '[]'));
  const insert = db.prepare('INSERT OR IGNORE INTO links (source_page_id, target_page_id) VALUES (?, ?)');
  for (const targetId of targets) insert.run(page.id, targetId);
}

// Pull: everything for this user updated strictly after `since` (an ISO/sqlite
// datetime string), so the client can refresh its offline cache.
router.get('/pull', (req, res) => {
  const db = getDb();
  const since = req.query.since || '1970-01-01 00:00:00';
  const pages = db.prepare(
    `SELECT * FROM pages WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC`
  ).all(req.user.id, since);

  res.json({
    serverTime: db.prepare("SELECT datetime('now') as t").get().t,
    pages: pages.map((p) => ({
      ...p,
      content_json: JSON.parse(p.content_json || '[]'),
      ink_json: JSON.parse(p.ink_json || '[]'),
    })),
  });
});

// Push: client sends queued offline edits. Each mutation carries the page's
// state as the client last saw/edited it, plus `base_updated_at` (the
// updated_at the client had cached before editing). Last-write-wins: a
// mutation is only applied if the server's current updated_at is not newer
// than what the client based its edit on.
router.post('/push', (req, res) => {
  const db = getDb();
  const mutations = Array.isArray(req.body.mutations) ? req.body.mutations : [];
  const results = [];

  for (const m of mutations) {
    const current = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(m.id, req.user.id);

    if (m.op === 'delete') {
      if (current) db.prepare("UPDATE pages SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?").run(m.id);
      results.push({ id: m.id, status: 'ok' });
      continue;
    }

    if (current && m.base_updated_at && current.updated_at > m.base_updated_at) {
      results.push({ id: m.id, status: 'conflict', server: current });
      continue;
    }

    if (current) {
      db.prepare(`
        UPDATE pages SET title = ?, icon = ?, content_json = ?, ink_json = ?,
          parent_id = ?, sort_order = ?, type = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(m.title, m.icon || null, JSON.stringify(m.content_json || []), JSON.stringify(m.ink_json || []),
        m.parent_id || null, m.sort_order || 0, m.type || 'doc', m.id);
    } else {
      db.prepare(`
        INSERT INTO pages (id, user_id, parent_id, title, icon, type, content_json, ink_json, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(m.id, req.user.id, m.parent_id || null, m.title || 'Untitled', m.icon || null, m.type || 'doc',
        JSON.stringify(m.content_json || []), JSON.stringify(m.ink_json || []), m.sort_order || 0);
    }

    const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(m.id);
    reindexFts(db, page);
    syncLinks(db, page);
    results.push({ id: m.id, status: 'ok', updated_at: page.updated_at });
  }

  res.json({ results });
});

module.exports = router;
