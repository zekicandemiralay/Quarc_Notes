// Notebook geometry: a handwriting page is a vertical stack of real paper
// sheets in Excalidraw's scene coordinates (CSS px at zoom 1, i.e. 96 dpi —
// A5 = 148 x 210 mm). Sheet 0's top-left is the scene origin, so notebooks
// drawn before multi-page support line up exactly with their first sheet.

export const PAGE_SIZES = {
  A5: { width: 559, height: 794, label: 'A5' },
  A4: { width: 794, height: 1123, label: 'A4' },
  Letter: { width: 816, height: 1056, label: 'Letter' },
};

export const PAGE_STYLES = ['lined', 'squared', 'dotted', 'empty'];

export const PAGE_GAP = 40; // scene px between sheets
export const CELL_SIZE = 28; // line/grid spacing (scene px) — unchanged, so existing notes stay on their lines
// Screen px kept clear around the notebook: Excalidraw's tool island floats
// over the top of the canvas and its zoom/undo controls over the bottom, so
// a fitted sheet sits between them instead of underneath.
export const INSETS = { top: 68, bottom: 60, side: 24 };
export const MAX_ZOOM = 6;

export function sheetDims(settings) {
  const base = PAGE_SIZES[settings?.pageSize] || PAGE_SIZES.A5;
  return settings?.orientation === 'landscape' ? { width: base.height, height: base.width } : { width: base.width, height: base.height };
}

export const sheetTop = (i, dims) => i * (dims.height + PAGE_GAP);
export const docHeight = (count, dims) => count * dims.height + Math.max(0, count - 1) * PAGE_GAP;

// Which sheet a scene y falls on (gaps belong to the sheet above).
export function sheetAt(y, count, dims) {
  return Math.min(count - 1, Math.max(0, Math.floor((y + PAGE_GAP / 2) / (dims.height + PAGE_GAP))));
}

// How many sheets the existing drawing needs (strokes below the last sheet
// would otherwise be unreachable).
export function sheetsNeeded(elements, dims) {
  let maxY = 0;
  for (const el of elements || []) {
    if (!el || el.isDeleted) continue;
    const bottom = (el.y || 0) + Math.max(0, el.height || 0);
    if (bottom > maxY) maxY = bottom;
  }
  return Math.max(1, Math.floor(maxY / (dims.height + PAGE_GAP)) + 1);
}

// Zoom at which one whole sheet fits the viewport — the zoom-out floor.
export function fitPageZoom(rect, dims) {
  return Math.max(
    0.05,
    Math.min((rect.width - 2 * INSETS.side) / dims.width, (rect.height - INSETS.top - INSETS.bottom) / dims.height)
  );
}

export function fitWidthZoom(rect, dims) {
  return Math.max(0.05, (rect.width - 2 * INSETS.side) / dims.width);
}

// Keeps the notebook on screen: on each axis the content can't be pushed
// past the insets, and content smaller than the free area stays centred in
// it. At "fit page" zoom a single sheet is therefore locked in place; with
// several sheets you scroll through them.
export function clampView(scrollX, scrollY, zoom, rect, dims, count) {
  const axis = (scroll, view, content, lead, trail) => {
    const min = (view - trail) / zoom - content;
    const max = lead / zoom;
    if (min > max) return (lead + (view - lead - trail) / 2) / zoom - content / 2;
    return Math.min(Math.max(scroll, min), max);
  };
  return {
    scrollX: axis(scrollX, rect.width, dims.width, INSETS.side, INSETS.side),
    scrollY: axis(scrollY, rect.height, docHeight(count, dims), INSETS.top, INSETS.bottom),
  };
}

// View showing sheet `i` at `zoom`: centred if it fits, else its top edge.
export function viewForSheet(i, zoom, rect, dims, count) {
  const top = sheetTop(i, dims);
  const free = rect.height - INSETS.top - INSETS.bottom;
  const fits = dims.height * zoom <= free + 0.5;
  const scrollY = fits ? (INSETS.top + free / 2) / zoom - (top + dims.height / 2) : INSETS.top / zoom - top;
  const scrollX = rect.width / (2 * zoom) - dims.width / 2;
  return { zoom, ...clampView(scrollX, scrollY, zoom, rect, dims, count) };
}

export function paperColors(dark) {
  return dark
    ? { desk: '#0b0b0d', paper: '#1b1b1f', shadow: 'rgba(0,0,0,0.6)', line: '#2b3442', grid: '#282d36', dot: '#3a4250' }
    : { desk: '#d4d4d4', paper: '#ffffff', shadow: 'rgba(0,0,0,0.18)', line: '#d6e4f0', grid: '#e2e8f0', dot: '#b8c4d2' };
}

// Draws every visible sheet (paper + its ruling) onto a canvas sized to the
// viewport. Cheap enough to run on every pan/zoom frame: it only ever
// clears and redraws within the existing buffer, never reallocates it.
export function drawPaper(canvas, view, rect, dims, count, style, colors) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  const { scrollX, scrollY, zoom } = view;
  const left = scrollX * zoom;
  const w = dims.width * zoom;
  const h = dims.height * zoom;
  const cell = CELL_SIZE * zoom;

  for (let i = 0; i < count; i++) {
    const top = (sheetTop(i, dims) + scrollY) * zoom;
    if (top > rect.height || top + h < 0 || left > rect.width || left + w < 0) continue;

    ctx.save();
    ctx.shadowColor = colors.shadow;
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = colors.paper;
    ctx.fillRect(left, top, w, h);
    ctx.restore();

    if (style === 'empty' || cell < 3) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, w, h);
    ctx.clip();
    const y0 = Math.max(cell, Math.ceil(-top / cell) * cell);
    const yEnd = Math.min(h, rect.height - top);
    if (style === 'dotted') {
      ctx.fillStyle = colors.dot;
      const r = Math.max(1, Math.min(2.2, zoom * 1.4));
      const x0 = Math.max(cell, Math.ceil(-left / cell) * cell);
      const xEnd = Math.min(w, rect.width - left);
      for (let y = y0; y < yEnd; y += cell) {
        for (let x = x0; x < xEnd; x += cell) {
          ctx.fillRect(Math.round(left + x - r / 2), Math.round(top + y - r / 2), r, r);
        }
      }
    } else {
      ctx.strokeStyle = style === 'squared' ? colors.grid : colors.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = y0; y < yEnd; y += cell) {
        const py = Math.round(top + y) + 0.5;
        ctx.moveTo(left, py);
        ctx.lineTo(left + w, py);
      }
      if (style === 'squared') {
        const x0 = Math.max(cell, Math.ceil(-left / cell) * cell);
        const xEnd = Math.min(w, rect.width - left);
        for (let x = x0; x < xEnd; x += cell) {
          const px = Math.round(left + x) + 0.5;
          ctx.moveTo(px, Math.max(top, 0));
          ctx.lineTo(px, Math.min(top + h, rect.height));
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
