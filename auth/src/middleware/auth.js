const jwt = require('jsonwebtoken');

const SECRET = () => process.env.JWT_SECRET || 'insecure-default-change-in-production';
const SECURE_COOKIE = process.env.SECURE_COOKIE === 'true';

// Sliding session — identical copy in every app's own requireAuth (Quarc
// Music, Quarc Notes) and intentionally so; see the comment there for the
// full reasoning. This copy matters most of all: GET /api/auth/me is what
// every app's checkSession() calls on launch, so this fires on literally
// every app open, whether or not the user goes on to touch anything else —
// the single most reliable place for a device's session to get extended.
const MAX_COOKIE_DAYS = 400;

function renewIfStale(req, res, user) {
  if (!user.iat || !user.exp) return;
  const now = Math.floor(Date.now() / 1000);
  const lifetime = user.exp - user.iat;
  const elapsed = now - user.iat;
  if (lifetime <= 0 || elapsed < lifetime / 2) return;

  const freshLifetimeSecs = Math.min(lifetime, MAX_COOKIE_DAYS * 86400);
  const { iat, exp, ...claims } = user;
  const token = jwt.sign(claims, SECRET(), { expiresIn: freshLifetimeSecs });
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: SECURE_COOKIE ? 'none' : 'lax',
    secure: SECURE_COOKIE,
    maxAge: freshLifetimeSecs * 1000,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, SECRET());
    renewIfStale(req, res, req.user);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

module.exports = { requireAuth, requireAdmin };
