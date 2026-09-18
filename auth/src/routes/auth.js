const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');

const SECRET = () => process.env.JWT_SECRET || 'insecure-default-change-in-production';
const SECURE_COOKIE = process.env.SECURE_COOKIE === 'true';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

// Fixed at login — no sliding renewal from activity, no server-side session
// to revoke, just this JWT's exp claim and the cookie's own maxAge. 7 days
// meant every user across every Quarc app got logged out weekly, all at
// once whenever a batch of them had logged in around the same time (e.g.
// after an app update forced a re-login). This is a personal, self-hosted
// suite behind its own auth + VPN, not a public multi-tenant service, so a
// short expiry mostly just means more frequent forced logins rather than
// meaningful extra safety — see Quarc Music's own (now unreachable) auth.js,
// which already made this exact call. Configurable since every app that
// shares this JWT_SECRET is affected by it.
//
// 365, not longer: Chrome/Edge and every Chromium WebView (the Android app,
// Tauri's WebView2 on Windows) cap a cookie's Max-Age at 400 days no matter
// what the server sends, silently truncating anything past that — so there
// is no gain from asking for more, only a false sense of it. 365 is a clean
// number safely under that cap with no edge-case risk from exact timing.
const SESSION_DAYS = Number(process.env.SESSION_LIFETIME_DAYS || 365);
const SESSION_LIFETIME = `${SESSION_DAYS}d`;
const COOKIE_OPTS = {
  httpOnly: true,
  // SameSite=none required when an APK (capacitor://localhost) or a different
  // app's origin sends requests to this shared service cross-origin.
  sameSite: SECURE_COOKIE ? 'none' : 'lax',
  maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  secure: SECURE_COOKIE,
  domain: COOKIE_DOMAIN,
};

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET(),
    { expiresIn: SESSION_LIFETIME }
  );

  res.cookie('token', token, COOKIE_OPTS);
  res.json({ id: user.id, username: user.username, role: user.role });
});

router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.trim().length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  const id = uuidv4();
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (id, username, password_hash, salt, role) VALUES (?, ?, ?, ?, ?)')
    .run(id, username.trim(), hash, salt, 'user');

  const token = jwt.sign({ id, username: username.trim(), role: 'user' }, SECRET(), { expiresIn: SESSION_LIFETIME });
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ id, username: username.trim(), role: 'user' });
});

router.post('/logout', (_req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: SECURE_COOKIE ? 'none' : 'lax', secure: SECURE_COOKIE, domain: COOKIE_DOMAIN });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = getDb()
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
