const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || path.join(__dirname, '..', '..', 'data', 'attachments');
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ATTACHMENTS_DIR),
  // Only keep a short, plain extension from the original name — never any
  // path parts of it.
  filename: (_req, file, cb) => {
    const ext = path.extname(path.basename(file.originalname || '')).toLowerCase();
    cb(null, `${uuidv4()}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/:pageId', (req, res) => {
  const db = getDb();
  const page = db.prepare('SELECT id FROM pages WHERE id = ? AND user_id = ?').get(req.params.pageId, req.user.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const id = uuidv4();
    db.prepare('INSERT INTO attachments (id, page_id, filename, filepath) VALUES (?, ?, ?, ?)').run(
      id,
      req.params.pageId,
      req.file.originalname,
      req.file.filename
    );
    res.status(201).json({ id, filename: req.file.originalname, url: `/api/attachments/file/${req.file.filename}` });
  });
});

// Only the owner of the page a file was attached to can fetch it.
router.get('/file/:filename', (req, res) => {
  const name = path.basename(req.params.filename);
  const owned = getDb()
    .prepare(
      `SELECT a.filename FROM attachments a JOIN pages p ON p.id = a.page_id
       WHERE a.filepath = ? AND p.user_id = ?`
    )
    .get(name, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(ATTACHMENTS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  // Files are immutable (new uuid per upload): cache hard on the device.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
});

module.exports = router;
