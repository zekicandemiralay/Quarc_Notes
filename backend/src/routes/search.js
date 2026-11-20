const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// FTS5 snippet() markers: control characters that can't appear in note
// text, swapped for <mark> only AFTER the snippet is HTML-escaped — the
// client renders snippets as HTML, so note text must never be markup.
const OPEN = '\u0001';
const CLOSE = '\u0002';

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim().slice(0, 200);
  if (!q) return res.json([]);

  // FTS5 query syntax chars can throw if passed raw; wrap each term to keep it a
  // simple phrase/prefix match instead of parsing user input as an FTS query.
  const ftsQuery = q
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(' ');

  let rows;
  try {
    rows = getDb()
      .prepare(
        `SELECT p.id, p.title, p.icon, p.type, p.updated_at,
                snippet(pages_fts, 2, ?, ?, '…', 12) as snippet
         FROM pages_fts
         JOIN pages p ON p.id = pages_fts.page_id
         WHERE pages_fts MATCH ? AND p.user_id = ? AND p.is_deleted = 0
         ORDER BY rank
         LIMIT 50`
      )
      .all(OPEN, CLOSE, ftsQuery, req.user.id);
  } catch {
    return res.json([]);
  }

  res.json(
    rows.map((r) => ({
      ...r,
      snippet: escapeHtml(r.snippet || '').split(OPEN).join('<mark>').split(CLOSE).join('</mark>'),
    }))
  );
});

module.exports = router;
