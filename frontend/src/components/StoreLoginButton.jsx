// Quarc Store sign-in options for an app's login screen. Safe to drop into
// any Quarc app's login page unconditionally:
//
//   Android app: "Continue as ⟨you⟩" (Quarc Store signed in on this phone)
//                or "Sign in with Quarc Store"; nothing if the Store isn't
//                installed.
//   Web/desktop: "Sign in with your phone" — type the shown number into
//                Quarc Store on your phone and this computer is signed in.
//
// Source of truth: Quarc_Store/sso-kit/web/StoreLoginButton.jsx

import { useEffect, useRef, useState } from 'react';
import i18n from 'i18next';
import { peekStore, syncFromStore, openStore, startPhoneSignIn, pollPhoneSignIn } from '../lib/storeSso';

const TEXT = {
  en: {
    continueAs: 'Continue as {{name}}',
    signInWithStore: 'Sign in with Quarc Store',
    signedInHint: 'Signed in to Quarc Store on this phone',
    openHint: 'Opens Quarc Store, then brings you back here',
    failed: "Quarc Store couldn't sign you in right now. Try again, or use your password below.",
    or: 'or',
    phone: 'Sign in with your phone',
    phoneHint: 'Approve it in Quarc Store on your phone — no password needed',
    username: 'Username',
    send: 'Send to my phone',
    enterOnPhone: 'Open Quarc Store on your phone and enter this number:',
    waiting: 'Waiting for your phone…',
    denied: 'The request was declined on your phone.',
    expired: 'The request expired. Try again.',
    tryAgain: 'Try again',
    cancel: 'Cancel',
  },
  tr: {
    continueAs: '{{name}} olarak devam et',
    signInWithStore: 'Quarc Store ile giriş yap',
    signedInHint: 'Bu telefonda Quarc Store’a giriş yapılmış',
    openHint: 'Quarc Store’u açar, sonra seni buraya geri getirir',
    failed: 'Quarc Store şu anda giriş yapamadı. Tekrar dene ya da aşağıdan şifrenle giriş yap.',
    or: 'veya',
    phone: 'Telefonunla giriş yap',
    phoneHint: 'Telefonundaki Quarc Store’dan onayla — şifre gerekmez',
    username: 'Kullanıcı adı',
    send: 'Telefonuma gönder',
    enterOnPhone: 'Telefonunda Quarc Store’u aç ve bu sayıyı gir:',
    waiting: 'Telefonun bekleniyor…',
    denied: 'İstek telefonunda reddedildi.',
    expired: 'İsteğin süresi doldu. Tekrar dene.',
    tryAgain: 'Tekrar dene',
    cancel: 'İptal',
  },
};

function tx(key, vars = {}) {
  const lang = (i18n.language || 'en').slice(0, 2);
  const s = (TEXT[lang] || TEXT.en)[key] || TEXT.en[key];
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

const isAndroidApp = () => !!window?.Capacitor?.isNativePlatform?.();

function Divider() {
  return (
    <div className="mt-4 flex items-center gap-3 text-xs text-zinc-500">
      <span className="h-px flex-1 bg-zinc-700/60" />
      {tx('or')}
      <span className="h-px flex-1 bg-zinc-700/60" />
    </div>
  );
}

function StoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 8h14l-1.5 12h-11z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

const primary =
  'flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50';

// ── Android app: use the Store on this phone ───────────────────────────────

function OnThisPhone({ onSignedIn }) {
  const [store, setStore] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    peekStore().then((s) => alive && setStore(s));
    return () => {
      alive = false;
    };
  }, []);

  if (!store?.installed) return null;
  const signedIn = store.available && store.state === 'signed_in' && store.user;

  async function go() {
    setError('');
    if (!signedIn) {
      await openStore('login');
      return;
    }
    setBusy(true);
    const r = await syncFromStore({ force: true });
    setBusy(false);
    if (r.result === 'signed_in') await onSignedIn?.();
    else setError(tx('failed'));
  }

  return (
    <div className="mb-4">
      <button type="button" onClick={go} disabled={busy} className={primary}>
        <StoreIcon />
        {busy ? '…' : signedIn ? tx('continueAs', { name: store.user.username }) : tx('signInWithStore')}
      </button>
      <p className="mt-1.5 text-center text-xs text-zinc-500">{signedIn ? tx('signedInHint') : tx('openHint')}</p>
      {error && <p className="mt-2 rounded-lg bg-red-400/10 px-3 py-2 text-sm text-red-400">{error}</p>}
      <Divider />
    </div>
  );
}

// ── Web/desktop: approve on your phone ─────────────────────────────────────

function WithYourPhone({ onSignedIn }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [request, setRequest] = useState(null); // { id, secret, number }
  const [status, setStatus] = useState('idle'); // idle | sending | waiting | denied | expired
  const [error, setError] = useState('');
  const timer = useRef(null);
  const alive = useRef(true);

  useEffect(
    () => () => {
      alive.current = false;
      clearTimeout(timer.current);
    },
    []
  );

  function reset() {
    clearTimeout(timer.current);
    setRequest(null);
    setStatus('idle');
    setError('');
  }

  async function poll(req) {
    try {
      const r = await pollPhoneSignIn(req.id, req.secret);
      if (r.status === 'approved') {
        setStatus('idle');
        await onSignedIn?.();
        return;
      }
      if (r.status === 'denied' || r.status === 'expired') {
        setStatus(r.status);
        return;
      }
    } catch {
      // network blip: keep trying until the request expires
    }
    if (alive.current) timer.current = setTimeout(() => poll(req), 2000);
  }

  async function send(e) {
    e.preventDefault();
    setError('');
    setStatus('sending');
    try {
      const req = await startPhoneSignIn(username.trim());
      setRequest(req);
      setStatus('waiting');
      timer.current = setTimeout(() => poll(req), 2000);
    } catch (err) {
      setStatus('idle');
      setError(err.message);
    }
  }

  if (!open) {
    return (
      <div className="mb-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-500/60 py-2.5 text-sm font-semibold text-emerald-500 transition-colors hover:bg-emerald-500/10"
        >
          <StoreIcon /> {tx('phone')}
        </button>
        <p className="mt-1.5 text-center text-xs text-zinc-500">{tx('phoneHint')}</p>
        <Divider />
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-emerald-500/40 p-4">
      {status === 'waiting' && request ? (
        <div className="text-center">
          <p className="text-sm text-zinc-400">{tx('enterOnPhone')}</p>
          <p className="my-3 text-5xl font-bold tracking-widest text-emerald-500">{request.number}</p>
          <p className="text-xs text-zinc-500">{tx('waiting')}</p>
          <button type="button" onClick={reset} className="mt-3 text-xs text-zinc-500 hover:underline">
            {tx('cancel')}
          </button>
        </div>
      ) : status === 'denied' || status === 'expired' ? (
        <div className="text-center">
          <p className="text-sm text-zinc-400">{tx(status)}</p>
          <button type="button" onClick={reset} className={`${primary} mt-3`}>
            {tx('tryAgain')}
          </button>
        </div>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-2">
          <input
            className="rounded-lg border border-zinc-600 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500"
            placeholder={tx('username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoComplete="username"
            required
          />
          <button type="submit" disabled={status === 'sending'} className={primary}>
            {status === 'sending' ? '…' : tx('send')}
          </button>
          {error && <p className="rounded-lg bg-red-400/10 px-3 py-2 text-sm text-red-400">{error}</p>}
          <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-500 hover:underline">
            {tx('cancel')}
          </button>
        </form>
      )}
    </div>
  );
}

export default function StoreLoginButton({ onSignedIn }) {
  return isAndroidApp() ? <OnThisPhone onSignedIn={onSignedIn} /> : <WithYourPhone onSignedIn={onSignedIn} />;
}
