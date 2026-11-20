const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const store = require('../services/pageStore');

// All pages for the current user (flat list; client builds the tree from parent_id)
router.get('/', (req, res) => {
  const db = getDb();
  const includeDeleted = req.query.trash === '1';
  const pages = db
    .prepare(
      `SELECT id, parent_id, title, icon, type, sort_order, is_deleted, is_favorite, created_at, updated_at
       FROM pages WHERE user_id = ? AND is_deleted = ?
       ORDER BY sort_order ASC, created_at ASC`
    )
    .all(req.user.id, includeDeleted ? 1 : 0);
  res.json(pages);
});

router.get('/:id', (req, res) => {
  const page = store.getOwned(getDb(), req.user.id, req.params.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  res.json(store.serialize(page));
});

router.post('/', (req, res) => {
  const db = getDb();
  const fields = store.cleanFields(req.body);
  const page = db.transaction(() => store.insertPage(db, req.user.id, uuidv4(), fields, null))();
  res.status(201).json(store.serialize(page));
});

router.put('/:id', (req, res) => {
  const db = getDb();
  const current = store.getOwned(db, req.user.id, req.params.id);
  if (!current) return res.status(404).json({ error: 'Page not found' });
  if (req.body.parent_id !== undefined && !store.isValidParent(db, req.user.id, current.id, req.body.parent_id || null)) {
    return res.status(400).json({ error: 'Invalid parent' });
  }
  const fields = store.cleanFields(req.body);
  delete fields.type; // a page's type is fixed at creation
  const page = db.transaction(() => store.updatePageFields(db, req.user.id, current, fields, null))();
  res.json(store.serialize(page));
});

// Soft delete (trash) — page and all its descendants
router.delete('/:id', (req, res) => {
  const db = getDb();
  if (!store.getOwned(db, req.user.id, req.params.id)) return res.status(404).json({ error: 'Page not found' });
  db.transaction(() => store.softDeleteTree(db, req.user.id, req.params.id))();
  res.json({ ok: true });
});

// Restore — page and everything trashed under it
router.post('/:id/restore', (req, res) => {
  const db = getDb();
  if (!store.getOwned(db, req.user.id, req.params.id)) return res.status(404).json({ error: 'Page not found' });
  db.transaction(() => store.restoreTree(db, req.user.id, req.params.id))();
  res.json({ ok: true });
});

router.delete('/:id/permanent', (req, res) => {
  const db = getDb();
  if (!store.getOwned(db, req.user.id, req.params.id)) return res.status(404).json({ error: 'Page not found' });
  db.transaction(() => store.purgeTree(db, req.user.id, req.params.id))();
  res.json({ ok: true });
});

router.get('/:id/backlinks', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.title, p.icon, p.type FROM links l
       JOIN pages p ON p.id = l.source_page_id
       WHERE l.target_page_id = ? AND p.user_id = ? AND p.is_deleted = 0`
    )
    .all(req.params.id, req.user.id);
  res.json(rows);
});

module.exports = router;
