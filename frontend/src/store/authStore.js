import { create } from 'zustand';
import { apiUrl } from '../lib/apiUrl';

const useAuthStore = create((set, get) => ({
  user: JSON.parse(localStorage.getItem('quarc_user') || 'null'),
  loading: true,

  async login(username, password) {
    const res = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Login failed');
    }
    const user = await res.json();
    localStorage.setItem('quarc_user', JSON.stringify(user));
    set({ user, loading: false });
    return user;
  },

  async logout() {
    await fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' }).catch(() => {});
    localStorage.removeItem('quarc_user');
    set({ user: null, loading: false });
  },

  async checkSession() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(apiUrl('/api/auth/me'), { credentials: 'include', signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const user = await res.json();
        localStorage.setItem('quarc_user', JSON.stringify(user));
        set({ user, loading: false });
      } else {
        localStorage.removeItem('quarc_user');
        set({ user: null, loading: false });
      }
    } catch {
      // Network error/offline — fall back to the last cached user rather than
      // logging out, so the app stays usable offline.
      set({ user: get().user, loading: false });
    }
  },
}));

export default useAuthStore;
