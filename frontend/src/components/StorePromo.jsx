// "Get Quarc Store" in an app's update info — only on Android, only when the
// Store isn't installed, and only during the first releases after the Store
// launched (see STORE_PROMO_UNTIL in lib/storeSso.js). Renders nothing
// otherwise, so it's safe to place unconditionally.
//
//   <StorePromo compact />  — an inline link, for the "update available" strip
//   <StorePromo />          — a small card, for the update section in Settings
//
// Source of truth: Quarc_Store/sso-kit/web/StorePromo.jsx

import { useEffect, useState } from 'react';
import i18n from 'i18next';
import { shouldPromoteStore, openStoreDownload } from '../lib/storeSso';

const TEXT = {
  en: {
    compact: 'Get Quarc Store',
    title: 'Get Quarc Store',
    body: 'Install and update every Quarc app in one place, and sign in once for all of them.',
    download: 'Download Quarc Store',
  },
  tr: {
    compact: 'Quarc Store’u edin',
    title: 'Quarc Store’u edin',
    body: 'Tüm Quarc uygulamalarını tek yerden yükle ve güncelle, hepsine bir kez giriş yap.',
    download: 'Quarc Store’u indir',
  },
};

function tx(key) {
  const lang = (i18n.language || 'en').slice(0, 2);
  return (TEXT[lang] || TEXT.en)[key] || TEXT.en[key];
}

export default function StorePromo({ compact = false }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let alive = true;
    shouldPromoteStore()
      .then((v) => alive && setShow(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!show) return null;

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
