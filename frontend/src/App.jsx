import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import useAuthStore from './store/authStore';
import { startSyncLoop } from './lib/sync';
import Login from './pages/Login/Login';
import Layout from './pages/Layout/Layout';
import PageView from './pages/PageView/PageView';
import Search from './pages/Search/Search';
import Trash from './pages/Trash/Trash';
import Settings from './pages/Settings/Settings';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuthStore();
  if (loading) return <div className="flex h-screen items-center justify-center">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const checkSession = useAuthStore((s) => s.checkSession);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (!user) return;
    return startSyncLoop();
  }, [user]);

  return (
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
        <Route index element={<Search />} />
        <Route path="page/:id" element={<PageView />} />
        <Route path="search" element={<Search />} />
        <Route path="trash" element={<Trash />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
