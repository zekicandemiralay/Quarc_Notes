// In-app update checking — mirrors Quarc Music's exact mechanism (same
// GitHub-releases-based check, same per-platform install behavior), just
// pointed at this repo. Native platforms only (Capacitor/Tauri); plain web
// has no "installed version" concept, so it only ever links out.

const REPO = 'zekicandemiralay/Quarc_Notes';

export function semverGt(a, b) {
  const pa = (a || '0').split('.').map(Number);
  const pb = (b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

export function getPlatform() {
  if (window?.Capacitor?.isNativePlatform?.()) return 'android';
  if (window?.__TAURI__) return 'desktop';
  return 'web';
}

export async function getCurrentVersion(platform) {
  try {
    if (platform === 'android') return (await window.Capacitor.Plugins.App.getInfo()).version;
    if (platform === 'desktop') return await window.__TAURI__.app.getVersion();
  } catch {
    /* native API unavailable — treat as unknown */
  }
  return null;
}

export async function fetchLatestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

export function getDownloadUrl(release, platform) {
  if (!release) return null;
  if (platform === 'android') return release.assets?.find((a) => a.name.endsWith('.apk'))?.browser_download_url;
  if (platform === 'desktop') {
    return release.assets?.find((a) => a.name.includes('x64-setup.exe'))?.browser_download_url ?? release.html_url;
  }
  return release.html_url;
}

export function installUpdate(platform, url, version) {
  if (platform === 'android') {
    window?.Capacitor?.Plugins?.Updater?.downloadUpdate({ url, version });
  } else if (platform === 'desktop') {
    // The NSIS installer updates in place.
    window.__TAURI__.shell.open(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
