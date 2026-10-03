const jwt = require('jsonwebtoken');

const SECRET = () => process.env.JWT_SECRET || 'insecure-default-change-in-production';
const SECURE_COOKIE = process.env.SECURE_COOKIE === 'true';

// Sliding session — keep this block identical to Quarc Music's copy
// (backend/src/middleware/auth.js there) and to any future Quarc app's.
// There's no shared package to import from, since each app verifies the
// JWT locally against the same secret with no network call per request
// (see quarc-auth's README) — so this is the one piece of logic that has
// to be copy-pasted deliberately rather than genuinely shared, and it
// needs to land everywhere this comment does.
//
// A fixed expiry always eventually runs out, identically for everyone, on
// whatever day they weren't using the app. Every request that reaches here
// already carries a token quarc-auth judged valid, so re-issue a fresh one
// with a full new window — silently, no frontend change needed, the same
// way on Web/Android/Desktop since all three just carry the cookie. From
// here the session effectively never expires AS LONG AS the device is used
// at least once before the old token would have run out.
//
// Derives its own renewal length from the token being renewed (exp - iat)
// rather than a second hardcoded number in this app, so whatever
// quarc-auth is configured to issue is what gets renewed to — changing
// SESSION_LIFETIME_DAYS in ONE place (quarc-auth's .env) is enough.
//
// Renews only past the HALFWAY point of the token's life, not on every
// request, and clamps to 400 days regardless of configured lifetime:
// Chrome/Edge/Chromium WebViews cap a cookie's Max-Age at 400 days and
// silently truncate anything past that.
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
