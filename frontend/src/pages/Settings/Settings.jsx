import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../../store/authStore';
import { apiUrl } from '../../lib/apiUrl';

export default function Settings() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');

  function changeLanguage(lng) {
    i18n.changeLanguage(lng);
    localStorage.setItem('language', lng);
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setMessage('');
    const res = await fetch(apiUrl('/api/auth/change-password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    setMessage(res.ok ? 'ok' : data.error);
    if (res.ok) {
      setCurrentPassword('');
      setNewPassword('');
    }
  }

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="mx-auto max-w-lg px-8 py-10">
      <h1 className="mb-6 text-xl font-semibold">{t('sidebar.settings')}</h1>

      <p className="mb-6 text-sm text-neutral-500">{user?.username}</p>

      <div className="mb-8">
        <label className="mb-2 block text-sm font-medium">{t('settings.language')}</label>
        <select
          value={i18n.language}
          onChange={(e) => changeLanguage(e.target.value)}
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-600"
        >
          <option value="en">English</option>
          <option value="tr">Türkçe</option>
        </select>
      </div>

      <form onSubmit={handleChangePassword} className="mb-8 flex flex-col gap-3">
        <label className="text-sm font-medium">{t('auth.changePassword')}</label>
        <input
          type="password"
          placeholder={t('auth.currentPassword')}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-600"
        />
        <input
          type="password"
          placeholder={t('auth.newPassword')}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 dark:border-neutral-600"
        />
        {message && <p className={`text-sm ${message === 'ok' ? 'text-green-600' : 'text-red-500'}`}>{message === 'ok' ? 'Saved' : message}</p>}
        <button type="submit" className="rounded-lg bg-accent px-3 py-2 font-medium text-white hover:bg-accent-dark">
          {t('auth.changePassword')}
        </button>
      </form>

      <button onClick={handleLogout} className="text-sm text-red-500 hover:underline">
        {t('settings.logout')}
      </button>
    </div>
  );
}
