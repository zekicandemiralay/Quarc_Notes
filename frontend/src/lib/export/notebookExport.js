// Notebook (Excalidraw scene on stacked paper sheets) -> PDF / PNG / SVG /
// .excalidraw. Every sheet is rendered by itself, on light paper, whatever
// the theme on screen.
//
// The scene is cut into sheets by where each element sits; a transparent
// rectangle the size of the sheet is added to what Excalidraw exports so the
// result is exactly the sheet (not just the bounding box of the ink).

import { sheetDims, sheetTop, sheetAt, sheetsNeeded, CELL_SIZE, paperColors } from '../../pages/PageView/canvas/notebook';
import { zipBlob } from './zip';
import { pdfBlob } from './pdf';

const LIGHT = paperColors(false);
const PX_TO_PT = 0.75; // CSS px (96 dpi) -> PDF points (72 dpi)

export const SCALE = { pdf: 3, png: 2 };

export function splitIntoSheets(ink, settings) {
  const dims = sheetDims(settings);
  const live = (ink?.elements || []).filter((e) => e && !e.isDeleted);
  const count = Math.max(settings?.pageCount || 1, sheetsNeeded(live, dims));
  const sheets = Array.from({ length: count }, () => []);
  for (const el of live) sheets[sheetAt((el.y || 0) + (el.height || 0) / 2, count, dims)].push(el);
  return { dims, count, sheets };
}

const loadExcalidraw = () => import('@excalidraw/excalidraw');

function sheetMarker(lib, dims, top) {
  return lib.convertToExcalidrawElements([
    { type: 'rectangle', x: 0, y: top, width: dims.width, height: dims.height, strokeColor: 'transparent', backgroundColor: 'transparent', strokeWidth: 1, roughness: 0 },
  ])[0];
}

const exportAppState = { exportBackground: false, viewBackgroundColor: 'transparent', exportWithDarkMode: false };

function paintPaper(ctx, w, h, scale, style) {
  ctx.fillStyle = LIGHT.paper;
  ctx.fillRect(0, 0, w, h);
  if (style === 'empty') return;
  const cell = CELL_SIZE * scale;
  if (style === 'dotted') {
    ctx.fillStyle = LIGHT.dot;
    const r = Math.max(2, scale * 1.4);
    for (let y = cell; y < h; y += cell) for (let x = cell; x < w; x += cell) ctx.fillRect(Math.round(x - r / 2), Math.round(y - r / 2), r, r);
    return;
  }
  ctx.strokeStyle = style === 'squared' ? LIGHT.grid : LIGHT.line;
  ctx.lineWidth = Math.max(1, scale * 0.8);
  ctx.beginPath();
  for (let y = cell; y < h; y += cell) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
  }
  if (style === 'squared') {
    for (let x = cell; x < w; x += cell) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
    }
  }
  ctx.stroke();
}

// One sheet as a canvas: paper (with its ruling if `paper`), then the ink.
export async function renderSheet(lib, { elements, files, dims, top, scale, style }) {
  const all = [sheetMarker(lib, dims, top), ...elements];
  const [minX, minY] = lib.getCommonBounds(all);
  const ink = await lib.exportToCanvas({
    elements: all,
    appState: exportAppState,
    files: files || {},
    exportPadding: 0,
    getDimensions: (w, h) => ({ width: Math.ceil(w * scale), height: Math.ceil(h * scale), scale }),
  });
  const out = document.createElement('canvas');
  out.width = Math.round(dims.width * scale);
  out.height = Math.round(dims.height * scale);
  const ctx = out.getContext('2d');
  paintPaper(ctx, out.width, out.height, scale, style);
  ctx.drawImage(ink, Math.round(minX * scale), Math.round((minY - top) * scale));
  ink.width = 0;
  return out;
}

const canvasBlob = (canvas, type = 'image/png') => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), type));

function paperSvg(dims, style, ox, oy) {
  const c = CELL_SIZE;
  let body = `<rect x="${ox}" y="${oy}" width="${dims.width}" height="${dims.height}" fill="${LIGHT.paper}"/>`;
  if (style === 'dotted') {
    for (let y = c; y < dims.height; y += c) for (let x = c; x < dims.width; x += c) body += `<circle cx="${ox + x}" cy="${oy + y}" r="1.1" fill="${LIGHT.dot}"/>`;
  } else if (style !== 'empty') {
    const stroke = style === 'squared' ? LIGHT.grid : LIGHT.line;
    let d = '';
    for (let y = c; y < dims.height; y += c) d += `M${ox} ${oy + y}H${ox + dims.width}`;
    if (style === 'squared') for (let x = c; x < dims.width; x += c) d += `M${ox + x} ${oy}V${oy + dims.height}`;
    body += `<path d="${d}" stroke="${stroke}" stroke-width="0.8" fill="none"/>`;
  }
  return body;
}

async function sheetSvg(lib, { elements, files, dims, top, style }) {
  const all = [sheetMarker(lib, dims, top), ...elements];
  const [minX, minY] = lib.getCommonBounds(all);
  const svg = await lib.exportToSvg({ elements: all, appState: exportAppState, files: files || {}, exportPadding: 0, skipInliningFonts: true });
  const ox = -minX;
  const oy = top - minY;
  svg.setAttribute('viewBox', `${ox} ${oy} ${dims.width} ${dims.height}`);
  svg.setAttribute('width', String(dims.width));
  svg.setAttribute('height', String(dims.height));
  const paper = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${paperSvg(dims, style, ox, oy)}</svg>`, 'image/svg+xml').documentElement;
  const at = [...svg.childNodes].find((n) => n.nodeName !== 'defs' && n.nodeName !== 'metadata' && n.nodeName !== 'style') || null;
  for (const node of [...paper.childNodes]) svg.insertBefore(svg.ownerDocument.importNode(node, true), at);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`;
}

// format: 'pdf' | 'png' | 'svg' | 'excalidraw'
// options: { paper: boolean (ruling on/off), onProgress(done, total) }
// -> { blob, ext } ; several PNG/SVG sheets come as a zip (ext 'zip')
export async function exportNotebook(format, { ink, settings, title, options = {} }) {
  const style = options.paper === false ? 'empty' : settings?.pageStyle || 'lined';
  const files = ink?.files || {};

  if (format === 'excalidraw') {
    const elements = (ink?.elements || []).filter((e) => e && !e.isDeleted);
    const json = JSON.stringify({ type: 'excalidraw', version: 2, source: 'Quarc Notes', elements, appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files }, null, 2);
    return { blob: new Blob([json], { type: 'application/json' }), ext: 'excalidraw' };
  }

  const lib = await loadExcalidraw();
  const { dims, count, sheets } = splitIntoSheets(ink, settings);
  const done = (i) => options.onProgress?.(i, count);
  const base = { files, dims, style };

  if (format === 'svg') {
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(await sheetSvg(lib, { ...base, elements: sheets[i], top: sheetTop(i, dims) }));
      done(i + 1);
    }
    if (out.length === 1) return { blob: new Blob([out[0]], { type: 'image/svg+xml' }), ext: 'svg' };
    return { blob: zipBlob(out.map((data, i) => ({ name: `${title}-${i + 1}.svg`, data }))), ext: 'zip' };
  }

  if (format === 'png') {
    const out = [];
    for (let i = 0; i < count; i++) {
      const canvas = await renderSheet(lib, { ...base, elements: sheets[i], top: sheetTop(i, dims), scale: SCALE.png });
      out.push(await canvasBlob(canvas));
      canvas.width = 0;
      done(i + 1);
    }
    if (out.length === 1) return { blob: out[0], ext: 'png' };
    const files = await Promise.all(out.map(async (b, i) => ({ name: `${title}-${i + 1}.png`, data: new Uint8Array(await b.arrayBuffer()) })));
    return { blob: zipBlob(files), ext: 'zip' };
  }

  // PDF: one page per sheet, the page the size of the sheet.
  const images = [];
  for (let i = 0; i < count; i++) {
    const canvas = await renderSheet(lib, { ...base, elements: sheets[i], top: sheetTop(i, dims), scale: SCALE.pdf });
    images.push(canvas.toDataURL('image/png'));
    canvas.width = 0;
    done(i + 1);
  }
  const W = dims.width * PX_TO_PT;
  const H = dims.height * PX_TO_PT;
  const blob = await pdfBlob({
    pageSize: { width: W, height: H },
    pageMargins: [0, 0, 0, 0],
    info: { title, creator: 'Quarc Notes', producer: 'Quarc Notes' },
    // A hair under the page height so rounding can't spill onto an extra page.
    content: images.map((image, i) => ({ image, width: W, height: H - 0.2, ...(i ? { pageBreak: 'before' } : {}) })),
  });
  return { blob, ext: 'pdf' };
}
