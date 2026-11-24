// Gets a generated file (a PDF, a Markdown page...) out of the app, the way
// each platform does it (same helper as Quarc Reader):
//   Android (Capacitor)  write to the app's cache, then the system share sheet
//                        ("Save to Files", Drive, mail...) — a WebView can't download blobs
//   Desktop (Tauri)      a native "Save as" dialog (older desktop builds without the
//                        dialog plugin fall through to an ordinary download)
//   Browser              an ordinary download
// Resolves to 'saved' | 'shared' | 'downloaded' | 'cancelled'.

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function saveBlob(blob, filename) {
  const cap = window.Capacitor;
  const plugins = cap?.Plugins;
  if (cap?.isNativePlatform?.() && plugins?.Filesystem && plugins?.Share) {
    const data = await blobToBase64(blob);
    const { uri } = await plugins.Filesystem.writeFile({ path: filename, data, directory: 'CACHE' });
    try {
      await plugins.Share.share({ title: filename, url: uri, dialogTitle: filename });
    } catch (err) {
      if (/cancel/i.test(String(err?.message))) return 'cancelled';
      throw err;
    }
    return 'shared';
  }
  const tauri = window.__TAURI__;
  if (tauri?.dialog?.save && tauri?.fs?.writeFile) {
    const ext = filename.includes('.') ? filename.split('.').pop() : '';
    const path = await tauri.dialog.save({ defaultPath: filename, ...(ext ? { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } : {}) });
    if (!path) return 'cancelled';
    await tauri.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return 'saved';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return 'downloaded';
}

// A name that is safe on every file system.
export function safeFilename(name, fallback = 'Untitled') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}
