import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../../store/authStore';
import { apiUrl } from '../../lib/apiUrl';
import {
  semverGt,
  getPlatform,
  getCurrentVersion,
  fetchLatestRelease,
  getDownloadUrl,
  installUpdate,
} from '../../lib/updateCheck';

function UpdateSection() {
  const { t } = useTranslation();
  const [platform] = useState(getPlatform);
  const [currentVersion, setCurrentVersion] = useState(null);
  const [release, setRelease] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [installing, setInstalling] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCurrentVersion(await getCurrentVersion(platform));
      setRelease(await fetchLatestRelease());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => { check(); }, [check]);

  const latestVersion = release?.tag_name?.replace(/^v/, '');
  const hasUpdate = currentVersion && latestVersion && semverGt(latestVersion, currentVersion);

  function handleInstall() {
    const url = getDownloadUrl(release, platform);
    if (!url) return;
    setInstalling(true);
    installUpdate(platform, url, latestVersion);
  }

  return (
    <div className="mb-8">
      <label className="mb-2 block text-sm font-medium">{t('updates.title')}</label>
      <div className="rounded-lg border border-neutral-300 p-3 text-sm dark:border-neutral-600">
        {loading && <p className="text-neutral-400">{t('updates.checking')}</p>}
        {error && !loading && <p className="text-red-500">{t('updates.error')}: {error}</p>}
        {!loading && !error && release && (
          <div className="space-y-2">
            {platform !== 'web' && currentVersion && (
              <div className="flex justify-between">
                <span className="text-neutral-400">{t('updates.installed')}</span>
                <span className="font-medium">v{currentVersion}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-neutral-400">{t('updates.latest')}</span>
              <span className="font-medium">{release.tag_name}</span>
            </div>
            <div className={`rounded-lg px-3 py-2 font-medium ${hasUpdate ? 'bg-amber-500/10 text-amber-600' : 'bg-green-500/10 text-green-600'}`}>
              {hasUpdate ? t('updates.updateAvailable') : t('updates.upToDate')}
            </div>
            {(hasUpdate || platform === 'web') && (
              platform !== 'web' ? (
                <button
                  onClick={handleInstall}
                  disabled={installing}
                  className="w-full rounded-lg bg-accent px-3 py-2 font-medium text-white hover:bg-accent-dark disabled:opacity-50"
                >
                  {installing ? t('updates.downloading') : t('updates.install')}
                </button>
              ) : (
                <a
                  href={release.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full rounded-lg bg-neutral-200 px-3 py-2 text-center font-medium hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600"
                >
                  {t('updates.viewRelease')}
                </a>
              )
            )}
          </div>
        )}
        <button onClick={check} disabled={loading} className="mt-2 text-xs text-neutral-400 hover:text-neutral-700 disabled:opacity-40 dark:hover:text-neutral-200">
          {t('updates.refresh')}
        </button>
      </div>
    </div>
  );
}

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

      <UpdateSection />

      <button onClick={handleLogout} className="text-sm text-red-500 hover:underline">
        {t('settings.logout')}
      </button>
    </div>
  );
}
