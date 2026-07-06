import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useAuthStore from '../../store/authStore';
import { apiUrl } from '../../lib/apiUrl';

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        const res = await fetch(apiUrl('/api/auth/register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Sign up failed');
        }
        await useAuthStore.getState().checkSession();
      }
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-100 dark:bg-neutral-900">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg dark:bg-neutral-800">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/logo.png" alt="Quarc Notes" className="h-16 w-16 rounded-xl" />
          <h1 className="text-lg font-semibold">{t('auth.signInToAccount')}</h1>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 outline-none focus:border-accent dark:border-neutral-600"
            placeholder={t('auth.username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <input
            className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 outline-none focus:border-accent dark:border-neutral-600"
            placeholder={t('auth.password')}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-lg bg-accent px-3 py-2 font-medium text-white hover:bg-accent-dark disabled:opacity-50"
          >
            {mode === 'login' ? t('auth.login') : t('auth.signup')}
          </button>
        </form>
        <button
          className="mt-4 w-full text-center text-sm text-neutral-500 hover:underline"
          onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
        >
          {mode === 'login' ? t('auth.needAccount') : t('auth.haveAccount')}
        </button>
      </div>
    </div>
  );
}
