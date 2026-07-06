import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { createPage } from '../../lib/api';
import PageTree from './PageTree';
import {
  getPlatform,
  getCurrentVersion,
  fetchLatestRelease,
  getDownloadUrl,
  installUpdate,
} from '../../lib/updateCheck';

function useUpdateCheck() {
  const [update, setUpdate] = useState(null); // { version, url, platform }
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const platform = getPlatform();
    if (platform === 'web') return;

    const check = async () => {
      try {
        const currentVersion = await getCurrentVersion(platform);
        const release = await fetchLatestRelease();
        const latest = release.tag_name?.replace(/^v/, '');
        if (!latest || latest === currentVersion) return;
        const url = getDownloadUrl(release, platform);
        if (url) setUpdate({ version: latest, url, platform });
      } catch {
        /* offline or GitHub unreachable — silently skip */
      }
    };
    const timer = setTimeout(check, 6000);
    return () => clearTimeout(timer);
  }, []);

  return { update: dismissed ? null : update, dismiss: () => setDismissed(true) };
}

export default function Layout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('quarc_sidebar_collapsed') === '1');
  const { update, dismiss: dismissUpdate } = useUpdateCheck();

  useEffect(() => {
    localStorage.setItem('quarc_sidebar_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  async function handleNewPage(type) {
    const page = await createPage({ title: 'Untitled', type });
    setRefreshKey((k) => k + 1);
    navigate(`/page/${page.id}`);
  }

  const refreshSidebar = useCallback(() => setRefreshKey((k) => k + 1), []);
  const collapseSidebar = useCallback(() => setCollapsed(true), []);

  function handleInstallUpdate() {
    installUpdate(update.platform, update.url, update.version);
    dismissUpdate();
  }

  return (
    <div className="flex h-screen flex-col">
      {update && (
        <div className="flex items-center justify-center gap-2 bg-emerald-700 px-4 py-1.5 text-xs font-medium text-white">
          {t('updates.updateAvailable')} — v{update.version}
          <button onClick={handleInstallUpdate} className="ml-2 underline underline-offset-2 hover:text-emerald-200">
            {t('updates.installNow')}
          </button>
          <button onClick={dismissUpdate} className="ml-2 hover:text-emerald-200">✕</button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {collapsed ? (
          <button
            onClick={() => setCollapsed(false)}
            className="fixed left-2 top-2 z-40 rounded-lg bg-neutral-800/80 p-2 text-white shadow-lg hover:bg-neutral-800"
            title={t('sidebar.expand')}
          >
            ☰
          </button>
        ) : (
          <aside className="flex w-64 flex-shrink-0 flex-col border-r border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800">
            <div className="flex items-center justify-between gap-2 p-4">
              <div className="flex items-center gap-2">
                <img src="/logo.png" alt="" className="h-7 w-7 rounded" />
                <span className="font-semibold">Quarc Notes</span>
              </div>
              <button
                onClick={() => setCollapsed(true)}
                className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                title={t('sidebar.collapse')}
              >
                ☰
              </button>
            </div>

            <div className="flex gap-2 px-3 pb-2">
              <button
                onClick={() => handleNewPage('doc')}
                className="flex-1 rounded-lg bg-accent px-2 py-1.5 text-sm font-medium text-white hover:bg-accent-dark"
              >
                + {t('sidebar.newPage')}
              </button>
              <button
                onClick={() => handleNewPage('canvas')}
                className="flex-1 rounded-lg border border-accent px-2 py-1.5 text-sm font-medium text-accent-dark hover:bg-accent/10"
              >
                ✏️ {t('sidebar.newCanvas')}
              </button>
            </div>

            <div className="flex flex-col gap-1 border-b border-neutral-200 px-3 pb-3 text-sm dark:border-neutral-700">
              <NavLink to="/search" className="rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-700">
                🔍 {t('sidebar.search')}
              </NavLink>
              <NavLink to="/trash" className="rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-700">
                🗑️ {t('sidebar.trash')}
              </NavLink>
            </div>

            <div className="flex-1 overflow-y-auto px-3 py-2">
              <PageTree refreshKey={refreshKey} />
            </div>

            <div className="border-t border-neutral-200 p-3 dark:border-neutral-700">
              <NavLink to="/settings" className="block rounded px-2 py-1 text-sm hover:bg-neutral-200 dark:hover:bg-neutral-700">
                ⚙️ {t('sidebar.settings')}
              </NavLink>
            </div>
          </aside>
        )}

        <main className="flex-1 overflow-y-auto">
          <Outlet
            context={{
              refreshSidebar,
              collapseSidebar,
              sidebarCollapsed: collapsed,
            }}
          />
        </main>
      </div>
    </div>
  );
}
