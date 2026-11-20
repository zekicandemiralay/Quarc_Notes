import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Search,
  Home,
  Trash2,
  Settings as SettingsIcon,
  FilePlus2,
  NotebookPen,
  PanelLeftClose,
  Star,
  Plus,
  Cloud,
  CloudOff,
  RefreshCw,
  AlertTriangle,
  X,
} from 'lucide-react';
import StorePromo from '../../components/StorePromo';
import QuickSwitcher from '../../components/QuickSwitcher';
import PageIcon from '../../components/PageIcon';
import { createPage } from '../../lib/api';
import { usePageIndex } from '../../lib/pageIndex';
import { useSyncStatus, sync } from '../../lib/sync';
import { relativeTime } from '../../lib/time';
import PageTree from './PageTree';
import { getPlatform, getCurrentVersion, fetchLatestRelease, getDownloadUrl, installUpdate, semverGt } from '../../lib/updateCheck';

function useUpdateCheck() {
  const [update, setUpdate] = useState(null); // { version, url, platform }
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const platform = getPlatform();
    if (platform === 'web') return undefined;
    const check = async () => {
      try {
        const currentVersion = await getCurrentVersion(platform);
        const release = await fetchLatestRelease();
        const latest = release.tag_name?.replace(/^v/, '');
        if (!latest || !currentVersion || !semverGt(latest, currentVersion)) return;
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

function useIsDesktop() {
  const query = '(min-width: 768px)';
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

function SyncIndicator() {
  const { t, i18n } = useTranslation();
  const { state, pending, lastSyncedAt } = useSyncStatus();
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  let Icon = Cloud;
  let label = lastSyncedAt ? t('sync.synced', { when: relativeTime(lastSyncedAt, i18n.language) }) : t('sync.idle');
  let tone = 'text-neutral-400';
  if (state === 'syncing') {
    Icon = RefreshCw;
    label = t('sync.syncing');
  } else if (state === 'offline') {
    Icon = CloudOff;
    label = t('sync.offline');
    tone = 'text-amber-600 dark:text-amber-400';
  } else if (state === 'error') {
    Icon = AlertTriangle;
    label = t('sync.error');
    tone = 'text-red-500';
  }
  return (
    <button
      type="button"
      onClick={() => sync()}
      title={t('sync.syncNow')}
      className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-neutral-200/70 dark:hover:bg-neutral-700/60 ${tone}`}
    >
      <Icon size={14} className={`shrink-0 ${state === 'syncing' ? 'animate-spin' : ''}`} />
      <span className="truncate">{label}</span>
      {pending > 0 && <span className="shrink-0 rounded-full bg-neutral-200 px-1.5 text-[10px] font-semibold text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">{t('sync.pending', { count: pending })}</span>}
    </button>
  );
}

function NavItem({ to, icon: Icon, children, onClick, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm ${
          isActive
            ? 'bg-neutral-200/80 font-medium text-neutral-900 dark:bg-neutral-700/70 dark:text-white'
            : 'text-neutral-600 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-700/50'
        }`
      }
    >
      <Icon size={17} className="shrink-0 opacity-80" />
      {children}
    </NavLink>
  );
}

function Sidebar({ onClose, onNavigate, onSearch, isDesktop }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const favorites = usePageIndex((s) => s.pages.filter((p) => p.is_favorite && !p.is_deleted));
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  async function newPage(type) {
    const page = await createPage({ type });
    navigate(`/page/${page.id}`);
    onNavigate();
  }

  return (
    <aside className="flex h-full w-72 flex-col border-r border-neutral-200 bg-neutral-50 md:w-64 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <img src="/logo.png" alt="" className="h-7 w-7 rounded-lg" />
          <span className="truncate font-semibold">Quarc Notes</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          title={t('sidebar.collapse')}
        >
          {isDesktop ? <PanelLeftClose size={18} /> : <X size={18} />}
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={onSearch}
          className="flex w-full items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-500 shadow-sm hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:border-neutral-600"
        >
          <Search size={16} />
          <span className="flex-1 text-left">{t('sidebar.search')}</span>
          {isDesktop && <kbd className="rounded border border-neutral-200 px-1 font-sans text-[10px] text-neutral-400 dark:border-neutral-600">{isMac ? '⌘K' : 'Ctrl K'}</kbd>}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={() => newPage('doc')}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-2 py-2 text-sm font-medium text-white shadow-sm hover:bg-accent-dark"
        >
          <FilePlus2 size={16} /> {t('sidebar.newPage')}
        </button>
        <button
          type="button"
          onClick={() => newPage('canvas')}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-accent/60 px-2 py-2 text-sm font-medium text-accent-dark hover:bg-accent/10 dark:text-amber-300"
        >
          <NotebookPen size={16} /> {t('sidebar.newCanvas')}
        </button>
      </div>

      <nav className="flex flex-col gap-0.5 px-2 pb-2">
        <NavItem to="/" end icon={Home} onClick={onNavigate}>
          {t('nav.home')}
        </NavItem>
        <NavItem to="/trash" icon={Trash2} onClick={onNavigate}>
          {t('sidebar.trash')}
        </NavItem>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {favorites.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
              <Star size={12} /> {t('sidebar.favorites')}
            </div>
            {favorites.map((p) => (
              <NavLink
                key={p.id}
                to={`/page/${p.id}`}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ${
                    isActive ? 'bg-accent/15 font-medium dark:bg-accent/20' : 'text-neutral-700 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-700/60'
                  }`
                }
              >
                <PageIcon page={p} size={15} />
                <span className="truncate">{p.title || t('page.untitled')}</span>
              </NavLink>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between px-2.5 pb-1 pt-2">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">{t('sidebar.pages')}</span>
          <button
            type="button"
            title={t('sidebar.newPage')}
            onClick={() => newPage('doc')}
            className="rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          >
            <Plus size={15} />
          </button>
        </div>
        <PageTree onNavigate={onNavigate} />
      </div>

      <div className="flex items-center gap-1 border-t border-neutral-200 p-2 dark:border-neutral-800">
        <SyncIndicator />
        <NavLink
          to="/settings"
          onClick={onNavigate}
          title={t('sidebar.settings')}
          className={({ isActive }) =>
            `rounded-lg p-2 ${isActive ? 'bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-white' : 'text-neutral-500 hover:bg-neutral-200/70 dark:hover:bg-neutral-700/60'}`
          }
        >
          <SettingsIcon size={17} />
        </NavLink>
      </div>
    </aside>
  );
}

export default function Layout() {
  const { t } = useTranslation();
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('quarc_sidebar_collapsed') === '1');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { update, dismiss: dismissUpdate } = useUpdateCheck();

  useEffect(() => {
    localStorage.setItem('quarc_sidebar_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  // The drawer closes on navigation (phones).
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcherOpen((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        setCollapsed((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sidebarVisible = isDesktop ? !collapsed : drawerOpen;
  const openSidebar = useCallback(() => (isDesktop ? setCollapsed(false) : setDrawerOpen(true)), [isDesktop]);
  const closeSidebar = useCallback(() => (isDesktop ? setCollapsed(true) : setDrawerOpen(false)), [isDesktop]);
  // Handwriting gets the whole screen width on tablets/laptops.
  const collapseForCanvas = useCallback(() => {
    if (window.matchMedia('(min-width: 768px)').matches && window.innerWidth < 1600) setCollapsed(true);
  }, []);
  const onNavigate = useCallback(() => {
    if (!isDesktop) setDrawerOpen(false);
  }, [isDesktop]);

  function handleInstallUpdate() {
    installUpdate(update.platform, update.url, update.version);
    dismissUpdate();
  }

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {update && (
        <div className="flex flex-wrap items-center justify-center gap-2 bg-emerald-700 px-4 py-1.5 text-xs font-medium text-white">
          {t('updates.updateAvailable')} — v{update.version}
          <button type="button" onClick={handleInstallUpdate} className="ml-2 underline underline-offset-2 hover:text-emerald-200">
            {t('updates.installNow')}
          </button>
          <StorePromo compact />
          <button type="button" onClick={dismissUpdate} className="ml-2 hover:text-emerald-200">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {isDesktop
          ? !collapsed && (
              <div className="shrink-0">
                <Sidebar isDesktop onClose={closeSidebar} onNavigate={onNavigate} onSearch={() => setSwitcherOpen(true)} />
              </div>
            )
          : drawerOpen && (
              <div className="fixed inset-0 z-50 flex">
                <div className="h-full shadow-2xl">
                  <Sidebar isDesktop={false} onClose={closeSidebar} onNavigate={onNavigate} onSearch={() => setSwitcherOpen(true)} />
                </div>
                <button type="button" aria-label={t('sidebar.collapse')} className="flex-1 bg-black/40" onClick={closeSidebar} />
              </div>
            )}

        <main className="min-w-0 flex-1 overflow-hidden">
          <Outlet context={{ sidebarVisible, openSidebar, collapseForCanvas, openSwitcher: () => setSwitcherOpen(true) }} />
        </main>
      </div>

      <QuickSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </div>
  );
}
