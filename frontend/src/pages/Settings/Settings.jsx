import StorePromo from '../../components/StorePromo';
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Monitor, Sun, Moon, LogOut, RefreshCw } from 'lucide-react';
import useAuthStore from '../../store/authStore';
import useSettings from '../../store/settingsStore';
import { apiUrl } from '../../lib/apiUrl';
import { useSyncStatus, sync } from '../../lib/sync';
import { relativeTime } from '../../lib/time';
import PageShell from '../../components/PageShell';
import { semverGt, getPlatform, getCurrentVersion, fetchLatestRelease, getDownloadUrl, installUpdate } from '../../lib/updateCheck';

function Section({ title, children }) {
  return (
    <section className="mb-6 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-800/40">
      <h2 className="mb-3 text-sm font-semibold text-neutral-500">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-neutral-500">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="inline-flex rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-900">
      {options.map(({ value: v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition ${
            value === v ? 'bg-white font-medium shadow-sm dark:bg-neutral-700' : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
          }`}
        >
          {Icon && <Icon size={14} />}
          {label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${checked ? 'bg-accent' : 'bg-neutral-300 dark:bg-neutral-600'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

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

  useEffect(() => {
    check();
  }, [check]);

  const latestVersion = release?.tag_name?.replace(/^v/, '');
  const hasUpdate = currentVersion && latestVersion && semverGt(latestVersion, currentVersion);

  function handleInstall() {
    const url = getDownloadUrl(release, platform);
    if (!url) return;
    setInstalling(true);
    installUpdate(platform, url, latestVersion);
  }

  return (
    <Section title={t('updates.title')}>
      <div className="text-sm">
        {loading && <p className="text-neutral-400">{t('updates.checking')}</p>}
        {error && !loading && (
          <p className="text-red-500">
            {t('updates.error')}: {error}
          </p>
        )}
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
            {(hasUpdate || platform === 'web') &&
              (platform !== 'web' ? (
                <button
                  type="button"
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
              ))}
            <StorePromo />
          </div>
        )}
        <button type="button" onClick={check} disabled={loading} className="mt-2 text-xs text-neutral-400 hover:text-neutral-700 disabled:opacity-40 dark:hover:text-neutral-200">
          {t('updates.refresh')}
        </button>
      </div>
    </Section>
  );
}

export default function Settings() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const prefs = useSettings();
  const { state, pending, lastSyncedAt } = useSyncStatus();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');

  function changeLanguage(lng) {
    i18n.changeLanguage(lng);
    localStorage.setItem('language', lng);
    document.documentElement.lang = lng;
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setMessage('');
    try {
      const res = await fetch(apiUrl('/api/auth/change-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(res.ok ? 'ok' : data.error || t('settings.passwordFailed'));
      if (res.ok) {
        setCurrentPassword('');
        setNewPassword('');
      }
    } catch {
      setMessage(t('sync.offline'));
    }
  }

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  const fingerMode = prefs.fingerMode === 'auto' ? (prefs.penSeen ? 'scroll' : 'draw') : prefs.fingerMode;

  return (
    <PageShell title={t('sidebar.settings')} width="max-w-2xl">
      <Section title={t('settings.appearance')}>
        <Row label={t('settings.theme')}>
          <Segmented
            value={prefs.theme}
            onChange={(v) => prefs.update({ theme: v })}
            options={[
              { value: 'system', label: t('settings.themeSystem'), icon: Monitor },
              { value: 'light', label: t('settings.themeLight'), icon: Sun },
              { value: 'dark', label: t('settings.themeDark'), icon: Moon },
            ]}
          />
        </Row>
        <Row label={t('settings.language')}>
          <Segmented
            value={i18n.language === 'tr' ? 'tr' : 'en'}
            onChange={changeLanguage}
            options={[
              { value: 'en', label: 'English' },
              { value: 'tr', label: 'Türkçe' },
            ]}
          />
        </Row>
      </Section>

      <Section title={t('settings.handwriting')}>
        <Row label={t('settings.finger')} hint={t('settings.fingerHint')}>
          <Segmented
            value={fingerMode}
            onChange={(v) => prefs.update({ fingerMode: v })}
            options={[
              { value: 'draw', label: t('settings.fingerDraw') },
              { value: 'scroll', label: t('settings.fingerScroll') },
            ]}
          />
        </Row>
        <Row label={t('canvas.shapeSnap')} hint={t('canvas.shapeSnapHint')}>
          <Toggle checked={prefs.shapeSnap} onChange={(v) => prefs.update({ shapeSnap: v })} label={t('canvas.shapeSnap')} />
        </Row>
        <Row label={t('canvas.darkPaper')} hint={t('settings.darkPaperHint')}>
          <Toggle checked={prefs.paperFollowsTheme} onChange={(v) => prefs.update({ paperFollowsTheme: v })} label={t('canvas.darkPaper')} />
        </Row>
      </Section>

      <Section title={t('settings.sync')}>
        <Row
          label={state === 'offline' ? t('sync.offline') : lastSyncedAt ? t('sync.synced', { when: relativeTime(lastSyncedAt, i18n.language) }) : t('sync.idle')}
          hint={pending ? t('sync.pendingLong', { count: pending }) : t('sync.allSaved')}
        >
          <button
            type="button"
            onClick={() => sync()}
            className="flex items-center gap-1.5 rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-medium hover:bg-neutral-200 dark:bg-neutral-700 dark:hover:bg-neutral-600"
          >
            <RefreshCw size={14} className={state === 'syncing' ? 'animate-spin' : ''} /> {t('sync.syncNow')}
          </button>
        </Row>
      </Section>

      <Section title={t('settings.account')}>
        <Row label={user?.username} hint={t('settings.sharedAccount')}>
          <button type="button" onClick={handleLogout} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10">
            <LogOut size={15} /> {t('settings.logout')}
          </button>
        </Row>
        <form onSubmit={handleChangePassword} className="flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-700">
          <label className="text-sm font-medium">{t('auth.changePassword')}</label>
          <input
            type="password"
            autoComplete="current-password"
            placeholder={t('auth.currentPassword')}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-accent dark:border-neutral-600"
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t('auth.newPassword')}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-accent dark:border-neutral-600"
          />
          {message && <p className={`text-sm ${message === 'ok' ? 'text-green-600' : 'text-red-500'}`}>{message === 'ok' ? t('settings.saved') : message}</p>}
          <button
            type="submit"
            disabled={!currentPassword || !newPassword}
            className="self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-40"
          >
            {t('auth.changePassword')}
          </button>
        </form>
      </Section>

      <UpdateSection />
    </PageShell>
  );
}
