import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // /api/auth/* goes to the shared Quarc Auth service; everything else
      // under /api/* goes to this app's own backend. Mirrors how nginx splits
      // these two routes in production.
      '/api/auth': {
        target: process.env.VITE_AUTH_PROXY_TARGET || 'http://localhost:3902',
        changeOrigin: true,
      },
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3903',
        changeOrigin: true,
      },
    },
  },
});
