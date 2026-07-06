import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { createPage } from '../../lib/api';
import PageTree from './PageTree';

export default function Layout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  async function handleNewPage(type) {
    const page = await createPage({ title: 'Untitled', type });
    setRefreshKey((k) => k + 1);
    navigate(`/page/${page.id}`);
  }

  return (
    <div className="flex h-screen">
      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800">
        <div className="flex items-center gap-2 p-4">
          <img src="/logo.png" alt="" className="h-7 w-7 rounded" />
          <span className="font-semibold">Quarc Notes</span>
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

      <main className="flex-1 overflow-y-auto">
        <Outlet context={{ refreshSidebar: () => setRefreshKey((k) => k + 1) }} />
      </main>
    </div>
  );
}
