const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
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

// All pages for the current user (flat list; client builds the tree from parent_id)
router.get('/', (req, res) => {
  const db = getDb();
  const includeDeleted = req.query.trash === '1';
  const pages = db.prepare(
    `SELECT id, parent_id, title, icon, type, sort_order, is_deleted, created_at, updated_at
     FROM pages WHERE user_id = ? AND is_deleted = ?
     ORDER BY sort_order ASC, created_at ASC`
  ).all(req.user.id, includeDeleted ? 1 : 0);
  res.json(pages);
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  res.json({
    ...page,
    content_json: JSON.parse(page.content_json || '[]'),
    ink_json: JSON.parse(page.ink_json || '[]'),
  });
});

router.post('/', (req, res) => {
  const db = getDb();
  const { title, parent_id, type, icon } = req.body;
  const id = uuidv4();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM pages WHERE user_id = ? AND parent_id IS ?')
    .get(req.user.id, parent_id || null).m;

  db.prepare(
    `INSERT INTO pages (id, user_id, parent_id, title, icon, type, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, req.user.id, parent_id || null, title || 'Untitled', icon || null, type || 'doc', maxOrder + 1);

  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
  reindexFts(db, page);
  res.status(201).json(page);
});

router.put('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Page not found' });

  const { title, icon, content_json, ink_json, parent_id, sort_order } = req.body;
  const fields = [];
  const values = [];
  if (title !== undefined) { fields.push('title = ?'); values.push(title); }
  if (icon !== undefined) { fields.push('icon = ?'); values.push(icon); }
  if (content_json !== undefined) { fields.push('content_json = ?'); values.push(JSON.stringify(content_json)); }
  if (ink_json !== undefined) { fields.push('ink_json = ?'); values.push(JSON.stringify(ink_json)); }
  if (parent_id !== undefined) { fields.push('parent_id = ?'); values.push(parent_id); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(sort_order); }
  fields.push("updated_at = datetime('now')");

  db.prepare(`UPDATE pages SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.params.id);

  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  reindexFts(db, page);
  syncLinks(db, page);
  res.json({ ...page, content_json: JSON.parse(page.content_json), ink_json: JSON.parse(page.ink_json) });
});

// Soft delete (trash) — page and all its descendants
router.delete('/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Page not found' });

  db.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM pages WHERE id = ?
      UNION ALL
      SELECT p.id FROM pages p JOIN descendants d ON p.parent_id = d.id
    )
    UPDATE pages SET is_deleted = 1, updated_at = datetime('now') WHERE id IN (SELECT id FROM descendants)
  `).run(req.params.id);

  res.json({ ok: true });
});

router.post('/:id/restore', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Page not found' });
  db.prepare("UPDATE pages SET is_deleted = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

router.delete('/:id/permanent', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM pages WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Page not found' });
  db.prepare('DELETE FROM pages WHERE id = ?').run(req.params.id); // cascades to links/tags/attachments
  db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/:id/backlinks', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.id, p.title, p.icon FROM links l
    JOIN pages p ON p.id = l.source_page_id
    WHERE l.target_page_id = ? AND p.user_id = ? AND p.is_deleted = 0
  `).all(req.params.id, req.user.id);
  res.json(rows);
});

module.exports = router;
