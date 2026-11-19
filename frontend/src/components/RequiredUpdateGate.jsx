// Blocks the app with an "Update required" screen when this installed
// version is older than the minimum the admin set in Quarc Store → Admin →
// Catalog. Android and desktop only — the web version is always current.
//
// Fails open: if the Store's server can't be reached and nothing is cached,
// the app simply runs. Never locks anyone out over a network problem.
//
// Mount once, next to <App />:  <RequiredUpdateGate packageName="com.quarc.music" />
// Source of truth: Quarc_Store/sso-kit/web/RequiredUpdateGate.jsx

import { useCallback, useEffect, useState } from 'react';
import i18n from 'i18next';
import { API_BASE } from '../lib/apiUrl';
import { updateViaStore, compareVersions } from '../lib/storeSso';

// Quarc Store's server: same host as this app's server, port 4006.
// Override at build time with VITE_STORE_URL if that ever changes.
const STORE_URL =
  import.meta.env.VITE_STORE_URL ||
  `${(API_BASE || window.location.origin).replace(/\/+$/, '').replace(/:\d+$/, '')}:4006`;

const TEXT = {
  en: {
    title: 'Update required',
    body: 'This version of {{name}} ({{current}}) no longer works with the server. Update to keep using it.',
    update: 'Update to {{version}}',
    updateNoVersion: 'Update',
    again: 'I already updated — check again',
  },
  tr: {
    title: 'Güncelleme gerekli',
    body: '{{name}} uygulamasının bu sürümü ({{current}}) artık sunucuyla çalışmıyor. Kullanmaya devam etmek için güncelle.',
    update: '{{version}} sürümüne güncelle',
    updateNoVersion: 'Güncelle',
    again: 'Zaten güncelledim — tekrar kontrol et',
  },
};

function tx(key, vars = {}) {
  const lang = (i18n.language || 'en').slice(0, 2);
  const s = (TEXT[lang] || TEXT.en)[key] || TEXT.en[key];
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function platform() {
  if (window?.Capacitor?.isNativePlatform?.()) return 'android';
  if (window?.__TAURI__) return 'desktop';
  return 'web';
}

async function installedVersion(p) {
  try {
    if (p === 'android') return (await window.Capacitor.Plugins.App.getInfo()).version;
    if (p === 'desktop') return await window.__TAURI__.app.getVersion();
  } catch {
    /* unknown */
  }
  return null;
}

export default function RequiredUpdateGate({ packageName }) {
  const [blocked, setBlocked] = useState(null);
  const cacheKey = `quarc_requirements_${packageName}`;

  const check = useCallback(async () => {
    const p = platform();
    if (p === 'web' || !packageName) return;
    const current = await installedVersion(p);
    if (!current) return;

    let reqs = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`${STORE_URL}/api/store/packages/${encodeURIComponent(packageName)}`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        reqs = await res.json();
        localStorage.setItem(cacheKey, JSON.stringify(reqs));
      } else if (res.status === 404) {
        localStorage.removeItem(cacheKey);
      }
    } catch {
      // Offline: use what the server said last time (if it said anything).
      try {
        reqs = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      } catch {
        reqs = null;
      }
    }

    if (reqs?.minVersion && compareVersions(current, reqs.minVersion) < 0) {
      setBlocked({ ...reqs, current, platform: p });
    } else {
      setBlocked(null);
    }
  }, [packageName, cacheKey]);

  useEffect(() => {
    check();
    const app = window?.Capacitor?.Plugins?.App;
    const handle = app?.addListener?.('resume', check);
    return () => {
      Promise.resolve(handle)
        .then((h) => h?.remove?.())
        .catch(() => {});
    };
  }, [check]);

  if (!blocked) return null;

  async function update() {
    const latest = blocked.latest;
    if (blocked.platform === 'android') {
      if (await updateViaStore()) return;
      const plugins = window.Capacitor?.Plugins || {};
      const updater = plugins.Updater || plugins.MusicService;
      if (latest?.apkUrl && updater?.downloadUpdate) updater.downloadUpdate({ url: latest.apkUrl, version: latest.version });
    } else if (blocked.platform === 'desktop' && latest?.htmlUrl) {
      window.__TAURI__?.shell?.open(latest.htmlUrl);
    }
  }

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-zinc-950 p-6 text-center text-white">
      <div className="w-full max-w-sm">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-400">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold">{tx('title')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">{tx('body', { name: blocked.name, current: blocked.current })}</p>
        <button
          type="button"
          onClick={update}
          className="mt-6 w-full rounded-lg bg-indigo-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-600"
        >
          {blocked.latest?.version ? tx('update', { version: blocked.latest.version }) : tx('updateNoVersion')}
        </button>
        <button type="button" onClick={check} className="mt-4 text-xs text-zinc-500 underline-offset-2 hover:underline">
          {tx('again')}
        </button>
      </div>
    </div>
  );
}
