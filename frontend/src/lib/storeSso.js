// Quarc Store single sign-on — the web side (Android app only; a no-op on
// the web and desktop). Source of truth: Quarc_Store/sso-kit/web/storeSso.js
//
// Wiring (see Quarc_Store/sso-kit/README.md):
//   - authStore.checkSession(): `await syncFromStore();` before GET /api/auth/me
//   - authStore.js (module level): `watchStoreSession(() => useAuthStore.getState().checkSession());`
//   - Login page: <StoreLoginButton onSignedIn={...} />

import { API_BASE } from './apiUrl';

const plugin = () => (window?.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.QuarcSso ?? null : null);

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/**
 * Applies Quarc Store's login to this app if it changed since last time.
 * Never throws and never takes long: app launch must not depend on the Store.
 * @returns {Promise<{result: 'unavailable'|'denied'|'unchanged'|'none'|'signed_in'|'signed_out'|'error'|'timeout', user?: object}>}
 */
export async function syncFromStore({ force = false } = {}) {
  const p = plugin();
  if (!p || !API_BASE) return { result: 'unavailable' };
  try {
    return await withTimeout(p.sync({ serverOrigin: API_BASE, force }), force ? 15000 : 4000, { result: 'timeout' });
  } catch {
    return { result: 'error' };
  }
}

/** Whether the Store is installed and who is signed in to it — changes nothing. */
export async function peekStore() {
  const p = plugin();
  if (!p) return { installed: false, available: false };
  try {
    return await withTimeout(p.peek(), 4000, { installed: false, available: false });
  } catch {
    return { installed: false, available: false };
  }
}

/** Opens Quarc Store ("login", "app/<package>", "updates"). Resolves to whether it opened. */
export async function openStore(target = '') {
  const p = plugin();
  if (!p) return false;
  try {
    return !!(await p.openStore({ target }))?.opened;
  } catch {
    return false;
  }
}

/** Numeric version comparison: 1.0.10 > 1.0.9. A leading "v" and suffixes are ignored. */
export function compareVersions(a, b) {
  const parse = (v) => String(v || '0').replace(/^[vV]/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ── Advertising Quarc Store (Android, Store not installed) ─────────────────

/** Always the newest Store APK (GitHub redirects to the latest release's asset). */
export const STORE_DOWNLOAD_URL = 'https://github.com/zekicandemiralay/Quarc_Store/releases/latest/download/Quarc-Store-Android.apk';

// Quarc Store is advertised in each app's update info during the first 10
// releases after it launched: while the installed version is below this.
// (Counted in patch versions — a minor/major bump ends it early.)
const STORE_PROMO_UNTIL = {
  'com.quarc.music': '1.0.85', //     1.0.75 – 1.0.84
  'com.quarc.notes': '1.2.14', //     1.2.4  – 1.2.13
  'com.quarc.weather': '1.0.16', //   1.0.6  – 1.0.15
  'com.quarc.translate': '1.0.12', // 1.0.2  – 1.0.11
  'com.quarc.calendar': '1.0.12', //  1.0.2  – 1.0.11
};

/** Android app, Quarc Store not installed, and still within the promo releases? */
export async function shouldPromoteStore() {
  if (!plugin()) return false;
  const store = await peekStore();
  if (store.installed) return false;
  const info = await window.Capacitor.Plugins.App?.getInfo?.().catch(() => null);
  const until = info && STORE_PROMO_UNTIL[info.id];
  return !!until && compareVersions(info.version, until) < 0;
}

/** Opens the Quarc Store APK download in the browser. */
export async function openStoreDownload() {
  try {
    await plugin()?.openUrl({ url: STORE_DOWNLOAD_URL });
  } catch {
    /* no browser — nothing more we can do */
  }
}

/**
 * Opens this app's page in Quarc Store, if the Store is installed, so the
 * update happens there (the Store then becomes this app's installer, and on
 * Android 12+ later updates need no confirmation). Resolves false when the
 * Store isn't available — fall back to the app's own updater.
 */
export async function updateViaStore() {
  if (!plugin()) return false;
  const info = await window.Capacitor.Plugins.App?.getInfo?.().catch(() => null);
  return info?.id ? openStore(`app/${info.id}`) : false;
}

// ── Sign in with your phone (web and desktop) ──────────────────────────────
// The computer asks; the user types the shown number into Quarc Store on
// their phone; the next poll signs this browser in (sets the login cookie).

async function postJson(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** @returns {Promise<{id, secret, number, expiresAt}>} */
export function startPhoneSignIn(username) {
  return postJson('/api/auth/approval/start', { username });
}

/** @returns {Promise<{status: 'pending'|'approved'|'denied'|'expired', user?}>} */
export function pollPhoneSignIn(id, secret) {
  return postJson('/api/auth/approval/poll', { id, secret });
}

let watching = false;

/**
 * Re-checks the Store whenever the app comes back to the foreground, so
 * signing in/out in the Store takes effect as soon as the user switches back.
 */
export function watchStoreSession(onChange) {
  const app = window?.Capacitor?.Plugins?.App;
  if (!plugin() || !app || watching) return;
  watching = true;
  app.addListener('resume', async () => {
    const r = await syncFromStore();
    if (r.result === 'signed_in' || r.result === 'signed_out') onChange(r);
  });
}
