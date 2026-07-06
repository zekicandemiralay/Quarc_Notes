const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { initDb } = require('./db');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'quarc-auth' }));
app.use('/api/auth', authRoutes);

initDb();

app.listen(PORT, () => {
  console.log(`Quarc Auth listening on :${PORT}`);
});
