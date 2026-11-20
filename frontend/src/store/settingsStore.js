import { create } from 'zustand';

// Per-device preferences (not synced), stored in localStorage — same
// pattern as Quarc Calendar's settings store.
const KEY = 'quarc_notes_settings';

const DEFAULTS = {
  theme: 'system', // 'light' | 'dark' | 'system'
  // Handwriting
  fingerMode: 'auto', // 'auto' | 'draw' | 'scroll' — auto: draw until a stylus is used here, then scroll
  penSeen: false, // a stylus has been used on this device
  shapeSnap: true, // hold the pen still at the end of a stroke to turn it into a clean shape
  paperFollowsTheme: true, // dark paper in dark mode (otherwise always light paper)
};

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function resolveDark(theme) {
  return theme === 'dark' || (theme === 'system' && !!media?.matches);
}

export function applyTheme(theme) {
  const dark = resolveDark(theme);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#171717' : '#fafafa');
  useSettings.setState({ isDark: dark });
}

const useSettings = create((set, get) => ({
  ...load(),
  isDark: false,
  update(patch) {
    set(patch);
    const { update, isDark, ...persist } = get(); // eslint-disable-line no-unused-vars
    try {
      localStorage.setItem(KEY, JSON.stringify(persist));
    } catch {
      /* storage unavailable: setting still applies for this session */
    }
    if (patch.theme) applyTheme(patch.theme);
  },
}));

// Follow the OS while the theme is "system".
media?.addEventListener?.('change', () => {
  if (useSettings.getState().theme === 'system') applyTheme('system');
});

export const useIsDark = () => useSettings((s) => s.isDark);

export default useSettings;
