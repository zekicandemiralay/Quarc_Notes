const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const db = getDb();
  // FTS5 query syntax chars can throw if passed raw; wrap each term to keep it a
  // simple phrase/prefix match instead of parsing user input as an FTS query.
  const ftsQuery = q.split(/\s+/).map((term) => `"${term.replace(/"/g, '""')}"*`).join(' ');

  const rows = db.prepare(`
    SELECT p.id, p.title, p.icon, p.type, p.updated_at,
           snippet(pages_fts, 2, '<mark>', '</mark>', '…', 10) as snippet
    FROM pages_fts
    JOIN pages p ON p.id = pages_fts.page_id
    WHERE pages_fts MATCH ? AND p.user_id = ? AND p.is_deleted = 0
    ORDER BY rank
    LIMIT 50
  `).all(ftsQuery, req.user.id);

  res.json(rows);
});

module.exports = router;
