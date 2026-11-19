// "Get Quarc Store" — only on Android, only when the Store isn't installed,
// and only during the first releases after the Store launched (see
// STORE_PROMO_UNTIL in lib/storeSso.js). Renders nothing otherwise, so it's
// safe to place unconditionally.
//
//   <StorePromo dialog />   — mounted once next to <App />: a one-time card
//                             after each update (once per installed version),
//                             so it's seen even when no newer update exists
//   <StorePromo compact />  — an inline link, for the "update available" strip
//   <StorePromo />          — a small card, for the update section in Settings
//
// Source of truth: Quarc_Store/sso-kit/web/StorePromo.jsx

import { useEffect, useState } from 'react';
import i18n from 'i18next';
import { shouldPromoteStore, openStoreDownload } from '../lib/storeSso';

const SEEN_KEY = 'quarc_store_promo_seen_version';

const TEXT = {
  en: {
    compact: 'Get Quarc Store',
    title: 'Get Quarc Store',
    body: 'Install and update every Quarc app in one place, and sign in once for all of them.',
    download: 'Download Quarc Store',
    notNow: 'Not now',
  },
  tr: {
    compact: 'Quarc Store’u edin',
    title: 'Quarc Store’u edin',
    body: 'Tüm Quarc uygulamalarını tek yerden yükle ve güncelle, hepsine bir kez giriş yap.',
    download: 'Quarc Store’u indir',
    notNow: 'Şimdi değil',
  },
};

function tx(key) {
  const lang = (i18n.language || 'en').slice(0, 2);
  return (TEXT[lang] || TEXT.en)[key] || TEXT.en[key];
}

async function installedVersion() {
  const info = await window.Capacitor?.Plugins?.App?.getInfo?.().catch(() => null);
  return info?.version || null;
}

export default function StorePromo({ compact = false, dialog = false }) {
  const [show, setShow] = useState(false);
  const [version, setVersion] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const promote = await shouldPromoteStore().catch(() => false);
      if (!promote || !alive) return;
      if (dialog) {
        // Once per installed version: each promo release shows it once.
        const v = await installedVersion();
        let seen = null;
        try {
          seen = localStorage.getItem(SEEN_KEY);
        } catch {
          /* storage unavailable — show it */
        }
        if (!alive || (v && seen === v)) return;
        setVersion(v);
      }
      setShow(true);
    })();
    return () => {
      alive = false;
    };
  }, [dialog]);

  if (!show) return null;

  if (dialog) {
    const close = () => {
      try {
        if (version) localStorage.setItem(SEEN_KEY, version);
      } catch {
        /* ignore */
      }
      setShow(false);
    };
    return (
      <div className="fixed inset-0 z-[9000] flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={close}>
        <div
          role="dialog"
          aria-modal="true"
          className="w-full max-w-sm rounded-2xl bg-zinc-900 p-6 text-center text-white shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 8h14l-1.5 12h-11z" />
              <path d="M9 8V6a3 3 0 0 1 6 0v2" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold">{tx('title')}</h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">{tx('body')}</p>
          <button
            type="button"
            onClick={() => {
              openStoreDownload();
              close();
            }}
            className="mt-6 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            {tx('download')}
          </button>
          <button type="button" onClick={close} className="mt-3 w-full py-1.5 text-sm text-zinc-400 hover:text-white">
            {tx('notNow')}
          </button>
        </div>
      </div>
    );
  }

  if (compact) {
    return (
      <button type="button" onClick={openStoreDownload} className="ml-2 underline underline-offset-2 hover:opacity-80">
        {tx('compact')}
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-left text-sm">
      <p className="font-semibold text-emerald-600">{tx('title')}</p>
      <p className="mt-0.5 text-xs opacity-80">{tx('body')}</p>
      <button
        type="button"
        onClick={openStoreDownload}
        className="mt-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
      >
        {tx('download')}
      </button>
    </div>
  );
}
