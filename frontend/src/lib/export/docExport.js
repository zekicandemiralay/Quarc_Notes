// A document -> PDF / Markdown / HTML / plain text.
//
//   doc = { getBlocks(), toMarkdown(), toHTML() }   (the editor's export API)
//   -> { blob, ext }

import { blocksToPlainText, docToPdfDefinition, imageUrls, hasEmoji } from './docToPdf';
import { pdfBlob } from './pdf';
import { imagesForPdf, emojiToPng, fetchBlob, blobToDataUrl, extFromMime } from './images';
import { zipBlob } from './zip';
import { apiUrl } from '../apiUrl';

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Images that live inside the app (the server's attachments, or data: URLs)
// — the ones that would be lost in a plain text export.
const isLocalImage = (u) => u.startsWith('/api/') || u.startsWith('data:');

const PAGE_CSS = `
:root{color-scheme:light dark}
body{font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:46rem;margin:2.5rem auto;padding:0 1.25rem;color:#171717;background:#fff}
h1.title{font-size:2.2rem;line-height:1.15;margin:0 0 1.2rem}
h1,h2,h3{line-height:1.25;margin:1.6em 0 .4em}
img{max-width:100%;height:auto;border-radius:4px}
pre{background:#f4f4f5;padding:.8rem 1rem;border-radius:8px;overflow:auto;font-size:.88em}
code{background:#f0f0f1;padding:.1em .3em;border-radius:4px;font-size:.9em}
pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.1em 1em;border-left:3px solid #d4d4d4;color:#525252}
table{border-collapse:collapse;margin:1em 0}
td,th{border:1px solid #d4d4d4;padding:.4rem .7rem;vertical-align:top}
a{color:#1a5fb4}
hr{border:0;border-top:1px solid #d4d4d4;margin:1.5em 0}
@media (prefers-color-scheme:dark){body{color:#e5e5e5;background:#171717}pre{background:#262626}code{background:#2a2a2a}blockquote{border-color:#404040;color:#a3a3a3}td,th{border-color:#404040}hr{border-color:#404040}a{color:#8ab4f8}}
`;

async function inlineImages(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // The editor's own bookkeeping would otherwise leak the server's file paths.
  for (const el of doc.querySelectorAll('[data-url]')) el.removeAttribute('data-url');
  await Promise.all(
    [...doc.querySelectorAll('img[src]')].map(async (img) => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:') || !isLocalImage(src)) return;
      try {
        img.setAttribute('src', await blobToDataUrl(await fetchBlob(src)));
      } catch {
        img.setAttribute('src', apiUrl(src)); // couldn't be fetched: leave a working link
      }
    })
  );
  return doc.body.innerHTML;
}

export async function exportDocument(format, { title, icon, doc, byId = {}, options = {}, untitled = 'Untitled', lang = 'en', author, origin = '', fileBase = 'page' }) {
  const heading = title || untitled;

  if (format === 'pdf') {
    const blocks = doc.getBlocks();
    const images = await imagesForPdf(imageUrls(blocks));
    const iconImage = icon && hasEmoji(icon) ? emojiToPng(icon) : null;
    const definition = docToPdfDefinition(blocks, { title: heading, paper: options.paper, byId, origin, images, iconImage, untitled, author });
    return { blob: await pdfBlob(definition), ext: 'pdf' };
  }

  if (format === 'txt') {
    const text = `${heading}\n${'='.repeat(Math.min(60, heading.length))}\n\n${blocksToPlainText(doc.getBlocks(), { byId, untitled })}\n`;
    return { blob: new Blob([text], { type: 'text/plain;charset=utf-8' }), ext: 'txt' };
  }

  if (format === 'html') {
    const body = await inlineImages(await doc.toHTML());
    const page = `<!doctype html>\n<html lang="${escapeHtml(lang)}">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(heading)}</title>\n<style>${PAGE_CSS}</style>\n</head>\n<body>\n<h1 class="title">${icon ? `${escapeHtml(icon)} ` : ''}${escapeHtml(heading)}</h1>\n${body}\n</body>\n</html>\n`;
    return { blob: new Blob([page], { type: 'text/html;charset=utf-8' }), ext: 'html' };
  }

  // Markdown: a single .md, or — when the page has images of its own — a
  // zip with the .md and an assets/ folder, the way other note apps do it.
  let markdown = await doc.toMarkdown();
  const local = imageUrls(doc.getBlocks()).filter(isLocalImage);
  const assets = [];
  for (const [i, url] of local.entries()) {
    try {
      const blob = await fetchBlob(url);
      const name = `assets/image-${i + 1}.${extFromMime(blob.type)}`;
      assets.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
      markdown = markdown.split(url).join(name);
    } catch {
      /* stays a (server) link */
    }
  }
  const text = `# ${heading}\n\n${markdown}`;
  if (!assets.length) return { blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }), ext: 'md' };
  return { blob: zipBlob([{ name: `${fileBase}.md`, data: text }, ...assets]), ext: 'zip' };
}
