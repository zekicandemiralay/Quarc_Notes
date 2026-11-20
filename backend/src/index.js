const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { initDb } = require('./db');
const { requireAuth } = require('./middleware/auth');
const pagesRoutes = require('./routes/pages');
const searchRoutes = require('./routes/search');
const syncRoutes = require('./routes/sync');
const attachmentsRoutes = require('./routes/attachments');

function createApp() {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  // Handwritten notebooks with many pages of ink are big JSON documents.
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'quarc-notes-backend' }));

  app.use('/api/pages', requireAuth, pagesRoutes);
  app.use('/api/search', requireAuth, searchRoutes);
  app.use('/api/sync', requireAuth, syncRoutes);
  app.use('/api/attachments', requireAuth, attachmentsRoutes);
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const PORT = process.env.PORT || 3003;
  initDb();
  createApp().listen(PORT, () => {
    console.log(`Quarc Notes backend listening on :${PORT}`);
  });
}
