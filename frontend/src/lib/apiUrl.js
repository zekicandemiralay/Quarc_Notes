// When the APK bundles the frontend locally (loaded from capacitor://localhost),
// all relative /api/... paths must be prefixed with the server's actual origin.
// VITE_API_URL is set at build time for mobile; empty string for web (relative paths work).
export const API_BASE = import.meta.env.VITE_API_URL || '';

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}
