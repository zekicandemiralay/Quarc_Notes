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
  filename: (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/:pageId', upload.single('file'), (req, res) => {
  const db = getDb();
  const page = db.prepare('SELECT id FROM pages WHERE id = ? AND user_id = ?').get(req.params.pageId, req.user.id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const id = uuidv4();
  db.prepare('INSERT INTO attachments (id, page_id, filename, filepath) VALUES (?, ?, ?, ?)')
    .run(id, req.params.pageId, req.file.originalname, req.file.filename);

  res.status(201).json({ id, filename: req.file.originalname, url: `/api/attachments/file/${req.file.filename}` });
});

router.get('/file/:filename', (req, res) => {
  const filePath = path.join(ATTACHMENTS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

module.exports = router;
