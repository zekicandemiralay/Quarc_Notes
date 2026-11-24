// A document (BlockNote blocks) -> a pdfmake document definition. Pure data
// in, pure data out (no pdfmake import), so it can be tested in Node and the
// big PDF library is only loaded when someone actually exports.
//
// Real text (selectable, searchable, small files), Roboto for the text and
// Roboto Mono for code. Emoji and symbols those fonts lack are dropped
// instead of printing empty boxes.

export const PAPER = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
};
export const PDF_MARGIN = 56;

const BASE = 11;
const LINK = '#1a5fb4';
const MUTED = '#737373';
const RULE = '#d4d4d4';

// BlockNote's named colours, as its light theme shows them.
const TEXT_COLORS = { gray: '#9b9a97', brown: '#64473a', red: '#e03e3e', orange: '#d9730d', yellow: '#dfab01', green: '#4d6461', blue: '#0b6e99', purple: '#6940a5', pink: '#ad1a72' };
const BG_COLORS = { gray: '#ebeced', brown: '#e9e5e3', red: '#fbe4e4', orange: '#f6e9d9', yellow: '#fbf3db', green: '#ddedea', blue: '#ddebf1', purple: '#eae4f2', pink: '#f4dfeb' };

const HEADING_SIZE = { 1: 24, 2: 18, 3: 14.5, 4: 12.5, 5: 11.5, 6: 11 };

// Pictographs, dingbats, regional-indicator flags, variation selectors,
// joiners and skin tones: none are in the PDF fonts.
const UNSUPPORTED = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{27BF}\u{2900}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
// ...but plain arrows and a few typographic symbols are in Roboto.
const KEEP = new Set(['←', '↑', '→', '↓', '↔', '↕', '•', '−']);

export function cleanText(text) {
  return String(text ?? '')
    .replace(/ /g, ' ')
    .replace(UNSUPPORTED, (ch) => (KEEP.has(ch) ? ch : ''));
}

// Lets a caller know the glyphs a piece of text would lose (for the
// optional emoji-as-image of the page icon).
export const hasEmoji = (s) => /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(String(s ?? ''));

function absoluteUrl(url, origin) {
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `${origin || ''}${url.startsWith('/') ? '' : '/'}${url}`;
}

// ---------- inline content ----------

function textSpan(text, styles = {}, base = {}) {
  const span = { ...base, text: cleanText(text) };
  const deco = [];
  if (base.decoration) deco.push(...[].concat(base.decoration));
  if (styles.bold) span.bold = true;
  if (styles.italic) span.italics = true;
  if (styles.underline && !deco.includes('underline')) deco.push('underline');
  if (styles.strike) deco.push('lineThrough');
  if (deco.length) span.decoration = deco;
  if (styles.code) {
    span.font = 'Mono';
    span.fontSize = (base.fontSize || BASE) * 0.88;
    span.background = '#eeeeee';
  }
  if (styles.textColor && TEXT_COLORS[styles.textColor]) span.color = TEXT_COLORS[styles.textColor];
  if (styles.backgroundColor && BG_COLORS[styles.backgroundColor]) span.background = BG_COLORS[styles.backgroundColor];
  return span;
}

export function inlineToSpans(content, ctx, base = {}) {
  if (typeof content === 'string') return [textSpan(content, {}, base)];
  const out = [];
  for (const node of content || []) {
    if (!node) continue;
    if (node.type === 'text') out.push(textSpan(node.text, node.styles, base));
    else if (node.type === 'link') out.push(...inlineToSpans(node.content, ctx, { ...base, link: absoluteUrl(node.href, ctx.origin), color: base.color || LINK, decoration: 'underline' }));
    else if (node.type === 'wikilink') {
      const title = ctx.byId?.[node.props?.pageId]?.title || node.props?.title || ctx.untitled || 'Untitled';
      out.push(textSpan(title, {}, { ...base, color: base.color || LINK }));
    } else if (typeof node.text === 'string') out.push(textSpan(node.text, node.styles, base));
  }
  return out.filter((s) => s.text !== '');
}

// ---------- blocks ----------

const noBorders = {
  hLineWidth: () => 0,
  vLineWidth: () => 0,
  paddingLeft: () => 0,
  paddingRight: () => 0,
  paddingTop: () => 0,
  paddingBottom: () => 0,
};

// A block's own text colour (applies to its text), and its alignment (applies to the block).
function blockColor(block) {
  const c = TEXT_COLORS[block.props?.textColor];
  return c ? { color: c } : {};
}
function blockAlign(block) {
  const a = block.props?.textAlignment;
  return a && a !== 'left' ? { alignment: a } : {};
}

function withBackground(node, block) {
  const bg = BG_COLORS[block.props?.backgroundColor];
  if (!bg) return node;
  return {
    table: { widths: ['*'], body: [[node]] },
    layout: { ...noBorders, fillColor: () => bg, paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 3, paddingBottom: () => 3 },
    margin: [0, 2, 0, 2],
  };
}

function paragraph(block, ctx, extra = {}) {
  const spans = inlineToSpans(block.content, ctx, { ...blockColor(block), ...extra.base });
  const text = spans.length ? spans : [{ text: ' ' }];
  return { text, lineHeight: 1.35, margin: extra.margin || [0, 3, 0, 3], ...blockAlign(block) };
}

function heading(block, ctx) {
  const level = Math.min(6, Math.max(1, block.props?.level || 1));
  const size = HEADING_SIZE[level];
  const spans = inlineToSpans(block.content, ctx, { fontSize: size, bold: true, ...blockColor(block) });
  return {
    text: spans.length ? spans : [{ text: ' ', fontSize: size }],
    headlineLevel: level, // never left alone at the bottom of a page (see pageBreakBefore)
    lineHeight: 1.2,
    margin: [0, level === 1 ? 14 : 10, 0, 4],
    ...blockAlign(block),
  };
}

function codeBlock(block, ctx) {
  const raw = (Array.isArray(block.content) ? block.content.map((n) => n.text ?? '').join('') : String(block.content ?? '')).replace(/\t/g, '    ');
  const lines = cleanText(raw).split('\n');
  const last = lines.length - 1;
  // One row per line, so a long listing can run over page breaks.
  return {
    table: {
      widths: ['*'],
      body: lines.map((l) => [{ text: l === '' ? ' ' : l, font: 'Mono', fontSize: 9, lineHeight: 1.25, preserveLeadingSpaces: true }]),
    },
    layout: {
      ...noBorders,
      fillColor: () => '#f4f4f5',
      paddingLeft: () => 9,
      paddingRight: () => 9,
      paddingTop: (i) => (i === 0 ? 8 : 0),
      paddingBottom: (i) => (i === last ? 8 : 0),
    },
    margin: [0, 4, 0, 6],
  };
}

function quote(block, ctx) {
  const node = paragraph(block, ctx, { base: { italics: true, color: '#525252', ...blockColor(block) }, margin: [0, 0, 0, 0] });
  const long = JSON.stringify(block.content || '').length > 1800;
  if (long) return { ...node, margin: [14, 4, 0, 4] };
  return {
    table: { widths: ['*'], body: [[node]] },
    layout: { ...noBorders, vLineWidth: (i) => (i === 0 ? 2.5 : 0), vLineColor: () => RULE, paddingLeft: () => 11, paddingTop: () => 2, paddingBottom: () => 2 },
    margin: [0, 4, 0, 4],
  };
}

function checkbox(checked) {
  const canvas = [{ type: 'rect', x: 0.5, y: 1.5, w: 9, h: 9, r: 2, lineWidth: 1, lineColor: checked ? '#b45309' : '#a3a3a3', ...(checked ? { color: '#f59e0b' } : {}) }];
  if (checked) canvas.push({ type: 'polyline', lineWidth: 1.4, lineColor: '#ffffff', points: [{ x: 2.6, y: 6.2 }, { x: 4.6, y: 8.2 }, { x: 7.8, y: 3.6 }] });
  return { canvas, width: 14, margin: [0, 3, 0, 0] };
}

function imageBlock(block, ctx) {
  const url = block.props?.url;
  const img = ctx.images?.[url];
  const caption = cleanText(block.props?.caption);
  const align = block.props?.textAlignment && block.props.textAlignment !== 'left' ? block.props.textAlignment : 'left';
  if (!img) {
    // Couldn't be loaded: a link instead of a hole.
    const name = cleanText(block.props?.name) || ctx.imageLabel || 'Image';
    return { text: [{ text: name, link: absoluteUrl(url, ctx.origin), color: LINK, decoration: 'underline' }], margin: [0, 4, 0, 4] };
  }
  const wanted = typeof block.props?.previewWidth === 'number' ? block.props.previewWidth * 0.75 : img.width * 0.75;
  let w = Math.min(wanted, ctx.contentWidth - (ctx.indent || 0));
  const maxH = ctx.contentHeight - 30;
  if ((w * img.height) / img.width > maxH) w = (maxH * img.width) / img.height;
  const stack = [{ image: img.dataUrl, width: w, alignment: align }];
  if (caption) stack.push({ text: caption, italics: true, fontSize: 9, color: MUTED, alignment: align === 'left' ? 'left' : align, margin: [0, 3, 0, 0] });
  return { stack, margin: [0, 5, 0, 5], unbreakable: true };
}

function linkBlock(block, ctx, label) {
  const name = cleanText(block.props?.name) || cleanText(block.props?.url) || label;
  const caption = cleanText(block.props?.caption);
  const stack = [{ text: [{ text: name, link: absoluteUrl(block.props?.url, ctx.origin), color: LINK, decoration: 'underline' }], margin: [0, 3, 0, 0] }];
  if (caption) stack.push({ text: caption, italics: true, fontSize: 9, color: MUTED });
  return { stack, margin: [0, 2, 0, 2] };
}

function tableBlock(block, ctx) {
  const content = block.content;
  const rows = content?.rows || [];
  if (!rows.length) return null;
  const headerRows = content.headerRows ?? 0;
  const headerCols = content.headerCols ?? 0;
  const cols = Math.max(...rows.map((r) => r.cells.reduce((n, c) => n + (c?.props?.colspan || 1), 0)));
  const available = ctx.contentWidth - (ctx.indent || 0);
  const widths = Array.from({ length: cols }, (_, i) => content.columnWidths?.[i]);
  const known = widths.every((w) => typeof w === 'number' && w > 0);
  const sum = known ? widths.reduce((a, b) => a + b, 0) : 0;
  const pdfWidths = known ? widths.map((w) => (w / sum) * (available - 2)) : widths.map(() => '*');

  const occupied = new Set(); // "r:c" taken by a cell spanning down/right
  const body = rows.map((row, r) => {
    const out = [];
    let c = 0;
    for (const cell of row.cells) {
      while (occupied.has(`${r}:${c}`)) {
        out.push({});
        c++;
      }
      const props = cell?.props || {};
      const inline = Array.isArray(cell) ? cell : cell?.content;
      const header = r < headerRows || c < headerCols;
      const base = { fontSize: 10, ...(header ? { bold: true } : {}), ...(props.textColor && TEXT_COLORS[props.textColor] ? { color: TEXT_COLORS[props.textColor] } : {}) };
      const spans = inlineToSpans(inline, ctx, base);
      const node = { text: spans.length ? spans : [{ text: ' ' }], lineHeight: 1.3 };
      if (props.textAlignment && props.textAlignment !== 'left') node.alignment = props.textAlignment;
      const bg = BG_COLORS[props.backgroundColor];
      if (bg) node.fillColor = bg;
      else if (header) node.fillColor = '#f4f4f5';
      const colSpan = props.colspan || 1;
      const rowSpan = props.rowspan || 1;
      if (colSpan > 1) node.colSpan = colSpan;
      if (rowSpan > 1) node.rowSpan = rowSpan;
      out.push(node);
      for (let k = 1; k < colSpan; k++) out.push({});
      for (let dr = 1; dr < rowSpan; dr++) for (let dc = 0; dc < colSpan; dc++) occupied.add(`${r + dr}:${c + dc}`);
      c += colSpan;
    }
    while (out.length < cols) out.push({});
    return out;
  });

  return {
    table: { widths: pdfWidths, body, ...(headerRows ? { headerRows } : {}) },
    layout: { hLineColor: () => RULE, vLineColor: () => RULE, hLineWidth: () => 0.7, vLineWidth: () => 0.7, paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 3.5, paddingBottom: () => 3.5 },
    margin: [0, 5, 0, 7],
  };
}

function divider(ctx) {
  return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: ctx.contentWidth - (ctx.indent || 0), y2: 0, lineWidth: 0.8, lineColor: RULE }], margin: [0, 8, 0, 8] };
}

const BULLETS = ['disc', 'circle', 'square'];

function listItem(block, ctx, depth) {
  const stack = [paragraph(block, ctx, { margin: [0, 1.5, 0, 1.5] })];
  if (block.children?.length) stack.push(...renderBlocks(block.children, ctx, depth + 1));
  return stack.length === 1 ? stack[0] : { stack };
}

export function renderBlocks(blocks, ctx, depth = 0) {
  const nodes = [];
  const child = { ...ctx, indent: (ctx.indent || 0) + 18 };
  for (let i = 0; i < (blocks || []).length; i++) {
    const block = blocks[i];
    const type = block.type;

    if (type === 'bulletListItem' || type === 'toggleListItem') {
      const items = [];
      while (i < blocks.length && (blocks[i].type === 'bulletListItem' || blocks[i].type === 'toggleListItem')) items.push(listItem(blocks[i++], child, depth));
      i--;
      nodes.push({ ul: items, type: BULLETS[depth % 3], markerColor: '#737373', margin: [0, 2, 0, 2] });
      continue;
    }
    if (type === 'numberedListItem') {
      const first = i;
      const items = [];
      while (i < blocks.length && blocks[i].type === 'numberedListItem') items.push(listItem(blocks[i++], child, depth));
      i--;
      const start = Number(blocks[first].props?.start);
      nodes.push({ ol: items, ...(Number.isFinite(start) && start > 0 ? { start } : {}), margin: [0, 2, 0, 2] });
      continue;
    }

    let node = null;
    switch (type) {
      case 'paragraph':
        node = withBackground(paragraph(block, ctx), block);
        break;
      case 'heading':
        node = withBackground(heading(block, ctx), block);
        break;
      case 'quote':
        node = quote(block, ctx);
        break;
      case 'codeBlock':
        node = codeBlock(block, ctx);
        break;
      case 'checkListItem':
        node = {
          columns: [checkbox(!!block.props?.checked), { stack: [paragraph(block, ctx, { margin: [0, 1.5, 0, 1.5], base: block.props?.checked ? { color: '#8a8a8a' } : {} })] }],
          columnGap: 4,
          margin: [0, 1, 0, 1],
        };
        if (block.props?.checked && node.columns[1].stack[0].text) for (const s of node.columns[1].stack[0].text) s.decoration = [].concat(s.decoration || [], 'lineThrough');
        break;
      case 'image':
        node = imageBlock(block, ctx);
        break;
      case 'video':
        node = linkBlock(block, ctx, 'Video');
        break;
      case 'audio':
        node = linkBlock(block, ctx, 'Audio');
        break;
      case 'file':
        node = linkBlock(block, ctx, 'File');
        break;
      case 'table':
        node = tableBlock(block, ctx);
        break;
      case 'divider':
        node = divider(ctx);
        break;
      default:
        if (Array.isArray(block.content)) node = paragraph(block, ctx);
    }
    if (node) nodes.push(node);
    if (block.children?.length) nodes.push({ stack: renderBlocks(block.children, child, depth + 1), margin: [18, 0, 0, 0] });
  }
  return nodes;
}

// ---------- the whole document ----------

// options: { title, paper: 'A4'|'Letter', byId, origin, images: { [url]: { dataUrl, width, height } },
//            iconImage?: dataUrl, untitled, author }
export function docToPdfDefinition(blocks, options = {}) {
  const paper = PAPER[options.paper] || PAPER.A4;
  const contentWidth = paper.width - 2 * PDF_MARGIN;
  const contentHeight = paper.height - 2 * PDF_MARGIN;
  const ctx = {
    byId: options.byId || {},
    origin: options.origin || '',
    images: options.images || {},
    untitled: options.untitled,
    imageLabel: options.imageLabel,
    contentWidth,
    contentHeight,
    indent: 0,
  };
  const title = cleanText(options.title || options.untitled || 'Untitled').trim();

  const head = [];
  if (options.iconImage) head.push({ image: options.iconImage, width: 30, margin: [0, 0, 0, 6] });
  head.push({ text: title || ' ', fontSize: 28, bold: true, lineHeight: 1.15, margin: [0, 0, 0, 10], headlineLevel: 1 });

  return {
    pageSize: { width: paper.width, height: paper.height },
    pageMargins: [PDF_MARGIN, PDF_MARGIN, PDF_MARGIN, PDF_MARGIN],
    info: { title: title || 'Untitled', creator: 'Quarc Notes', producer: 'Quarc Notes', ...(options.author ? { author: options.author } : {}) },
    defaultStyle: { font: 'Roboto', fontSize: BASE, color: '#171717' },
    content: [...head, ...renderBlocks(blocks, ctx)],
    footer: (current, count) => ({ text: `${current} / ${count}`, alignment: 'center', fontSize: 8, color: '#a3a3a3', margin: [0, 22, 0, 0] }),
    // A heading is never the last thing on a page.
    pageBreakBefore: (node, following) => !!node.headlineLevel && following.length === 0,
  };
}

// Image URLs a document needs (for the caller to fetch before building).
export function imageUrls(blocks, out = new Set()) {
  for (const b of blocks || []) {
    if (b.type === 'image' && b.props?.url) out.add(b.props.url);
    if (b.children?.length) imageUrls(b.children, out);
  }
  return [...out];
}

// Plain text of a document (the "Plain text" export).
export function blocksToPlainText(blocks, ctx = {}, depth = 0) {
  const lines = [];
  const inline = (content) => {
    if (typeof content === 'string') return content;
    return (content || [])
      .map((n) => {
        if (n.type === 'link') return inline(n.content);
        if (n.type === 'wikilink') return `[[${ctx.byId?.[n.props?.pageId]?.title || n.props?.title || ctx.untitled || 'Untitled'}]]`;
        return n.text ?? '';
      })
      .join('');
  };
  let number = 0;
  for (const b of blocks || []) {
    const pad = '  '.repeat(depth);
    number = b.type === 'numberedListItem' ? (b.props?.start && number === 0 ? Number(b.props.start) : number + 1) : 0;
    switch (b.type) {
      case 'heading':
        lines.push('', `${pad}${inline(b.content).toUpperCase()}`);
        break;
      case 'bulletListItem':
      case 'toggleListItem':
        lines.push(`${pad}- ${inline(b.content)}`);
        break;
      case 'numberedListItem':
        lines.push(`${pad}${number}. ${inline(b.content)}`);
        break;
      case 'checkListItem':
        lines.push(`${pad}[${b.props?.checked ? 'x' : ' '}] ${inline(b.content)}`);
        break;
      case 'quote':
        lines.push(`${pad}> ${inline(b.content)}`);
        break;
      case 'codeBlock':
        lines.push(...inline(b.content).split('\n').map((l) => `${pad}    ${l}`));
        break;
      case 'divider':
        lines.push(`${pad}---`);
        break;
      case 'table':
        for (const row of b.content?.rows || []) lines.push(`${pad}${row.cells.map((c) => inline(Array.isArray(c) ? c : c?.content)).join('\t')}`);
        break;
      case 'image':
      case 'video':
      case 'audio':
      case 'file':
        lines.push(`${pad}${[b.props?.name || b.props?.url, b.props?.caption].filter(Boolean).join(' — ')}`);
        break;
      default:
        lines.push(`${pad}${inline(b.content)}`);
    }
    if (b.children?.length) lines.push(...blocksToPlainText(b.children, ctx, depth + 1).split('\n'));
  }
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}
