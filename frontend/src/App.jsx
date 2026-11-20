import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useAuthStore from './store/authStore';
import useSettings, { applyTheme } from './store/settingsStore';
import { startSyncLoop } from './lib/sync';
import { ensureLocalOwner } from './lib/api';
import { reloadPageIndex } from './lib/pageIndex';
import { on } from './lib/events';
import Toasts, { toast } from './components/Toasts';
import Login from './pages/Login/Login';
import Layout from './pages/Layout/Layout';
import Home from './pages/Home/Home';
import PageView from './pages/PageView/PageView';
import Search from './pages/Search/Search';
import Trash from './pages/Trash/Trash';
import Settings from './pages/Settings/Settings';

function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-white dark:bg-neutral-900">
      <img src="/logo.png" alt="" className="h-14 w-14 animate-pulse rounded-2xl" />
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuthStore();
  if (loading && !user) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const checkSession = useAuthStore((s) => s.checkSession);
  const user = useAuthStore((s) => s.user);
  const theme = useSettings((s) => s.theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // The local cache belongs to the signed-in account; then keep it synced.
  useEffect(() => {
    if (!user?.id) return undefined;
    let stop = null;
    let cancelled = false;
    ensureLocalOwner(user.id).then(() => {
      if (cancelled) return;
      reloadPageIndex({ immediate: true });
      stop = startSyncLoop();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [user?.id]);

  // Both versions of a page edited on two devices at once are kept.
  useEffect(
    () =>
      on('conflict-copies', (ids) => {
        toast(t('sync.conflictToast'), {
          duration: 9000,
          action: { label: t('sync.open'), onClick: () => navigate(`/page/${ids[0]}`) },
        });
      }),
    [t, navigate]
  );

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Home />} />
          <Route path="page/:id" element={<PageView />} />
          <Route path="search" element={<Search />} />
          <Route path="trash" element={<Trash />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Toasts />
    </>
  );
}
