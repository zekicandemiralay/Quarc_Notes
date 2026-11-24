import { apiUrl } from '../apiUrl';

// Image helpers for exports: a page's images live on the server behind the
// login (relative /api/attachments/... URLs), or are small data: URLs.

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif' };
export const extFromMime = (mime) => MIME_EXT[String(mime).split(';')[0]] || 'bin';

export async function fetchBlob(url) {
  const full = url.startsWith('/api/') ? apiUrl(url) : url;
  const res = await fetch(full, { credentials: url.startsWith('data:') ? 'omit' : 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image'));
    };
    img.src = url;
  });
}

// An image as the PDF library wants it: a PNG or JPEG data URL (anything
// else — WebP, GIF, SVG — is redrawn as PNG), at most `maxSide` px.
export async function imageForPdf(url, maxSide = 1800) {
  const blob = await fetchBlob(url);
  const img = await loadImage(blob);
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * k));
  const height = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const jpeg = blob.type === 'image/jpeg';
  if (jpeg) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.9), width, height };
}

// url -> image, for every url that could be loaded (failures are left out,
// so the document shows a link instead of a hole).
export async function imagesForPdf(urls) {
  const out = {};
  await Promise.all(
    urls.map(async (u) => {
      try {
        out[u] = await imageForPdf(u);
      } catch {
        /* skipped */
      }
    })
  );
  return out;
}

// An emoji drawn as a PNG (the PDF fonts have no emoji).
export function emojiToPng(emoji, size = 128) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(size * 0.78)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
    ctx.fillText(emoji, size / 2, size / 2 + size * 0.04);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
