// A document (BlockNote blocks) -> a Word document (.docx), built with the
// `docx` library so Word, Google Docs, LibreOffice and Pages all open it.
// Loaded only when someone exports to Word.
//
//   buildDocx(blocks, options) -> docx Document        (then Packer.toBlob)
//   options: { title, icon, paper: 'A4'|'Letter', byId, origin, images: { [url]: { dataUrl, width, height } },
//              untitled, lang, author }

import {
  Document,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  AlignmentType,
  HeadingLevel,
  LevelFormat,
  TableLayoutType,
} from 'docx';

const PAGE = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
};
const MARGIN = 1134; // 2 cm, in twips
const BODY_FONT = 'Calibri';
const CODE_FONT = 'Consolas';
const LINK = '1A5FB4';
const RULE = 'D4D4D4';

// BlockNote's named colours, as its light theme shows them (no '#').
const TEXT_COLORS = { gray: '9B9A97', brown: '64473A', red: 'E03E3E', orange: 'D9730D', yellow: 'DFAB01', green: '4D6461', blue: '0B6E99', purple: '6940A5', pink: 'AD1A72' };
const BG_COLORS = { gray: 'EBECED', brown: 'E9E5E3', red: 'FBE4E4', orange: 'F6E9D9', yellow: 'FBF3DB', green: 'DDEDEA', blue: 'DDEBF1', purple: 'EAE4F2', pink: 'F4DFEB' };

const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };

// Control characters Word's XML can't hold.
// eslint-disable-next-line no-control-regex
const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
export const cleanXmlText = (s) => String(s ?? '').replace(XML_BAD, '').replace(/\t/g, '    ');

const absoluteUrl = (url, origin) => {
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `${origin || ''}${url.startsWith('/') ? '' : '/'}${url}`;
};

// ---------- inline content ----------

// Text with line breaks -> runs (a hard break between lines).
function textRuns(text, run) {
  const lines = cleanXmlText(text).split('\n');
  return lines.map((line, i) => new TextRun({ ...run, text: line, ...(i ? { break: 1 } : {}) }));
}

function styleToRun(styles = {}, base = {}) {
  const run = { ...base };
  if (styles.bold) run.bold = true;
  if (styles.italic) run.italics = true;
  if (styles.underline) run.underline = {};
  if (styles.strike) run.strike = true;
  if (styles.code) {
    run.font = CODE_FONT;
    run.size = 20;
    run.shading = { type: ShadingType.CLEAR, color: 'auto', fill: 'EEEEEE' };
  }
  if (styles.textColor && TEXT_COLORS[styles.textColor]) run.color = TEXT_COLORS[styles.textColor];
  if (styles.backgroundColor && BG_COLORS[styles.backgroundColor]) run.shading = { type: ShadingType.CLEAR, color: 'auto', fill: BG_COLORS[styles.backgroundColor] };
  return run;
}

export function inlineToRuns(content, ctx, base = {}) {
  if (typeof content === 'string') return textRuns(content, base);
  const out = [];
  for (const node of content || []) {
    if (!node) continue;
    if (node.type === 'text') out.push(...textRuns(node.text, styleToRun(node.styles, base)));
    else if (node.type === 'link') {
      const link = absoluteUrl(node.href, ctx.origin);
      const runs = inlineToRuns(node.content, ctx, { ...base, color: base.color || LINK, underline: {} });
      out.push(new ExternalHyperlink({ link, children: runs }));
    } else if (node.type === 'wikilink') {
      const title = ctx.byId?.[node.props?.pageId]?.title || node.props?.title || ctx.untitled || 'Untitled';
      out.push(...textRuns(title, { ...base, color: base.color || LINK }));
    } else if (typeof node.text === 'string') out.push(...textRuns(node.text, styleToRun(node.styles, base)));
  }
  return out;
}

// ---------- blocks ----------

const blockColor = (block) => (TEXT_COLORS[block.props?.textColor] ? { color: TEXT_COLORS[block.props.textColor] } : {});
const blockAlign = (block) => (ALIGN[block.props?.textAlignment] && block.props.textAlignment !== 'left' ? { alignment: ALIGN[block.props.textAlignment] } : {});
const blockShading = (block) => (BG_COLORS[block.props?.backgroundColor] ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: BG_COLORS[block.props.backgroundColor] } } : {});

const indentFor = (ctx, extra = 0) => {
  const left = ctx.indent + extra;
  return left ? { indent: { left } } : {};
};

function paragraph(block, ctx, extra = {}) {
  return new Paragraph({
    children: inlineToRuns(block.content, ctx, { ...blockColor(block), ...extra.run }),
    ...blockAlign(block),
    ...blockShading(block),
    ...(extra.indent ? { indent: extra.indent } : indentFor(ctx)),
    ...extra.options,
  });
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function heading(block, ctx) {
  const level = Math.min(6, Math.max(1, block.props?.level || 1));
  return paragraph(block, ctx, { options: { heading: HEADINGS[level - 1] } });
}

function codeBlock(block, ctx) {
  const raw = Array.isArray(block.content) ? block.content.map((n) => n.text ?? '').join('') : String(block.content ?? '');
  const lines = cleanXmlText(raw).split('\n');
  return lines.map(
    (line, i) =>
      new Paragraph({
        style: 'CodeBlock',
        children: [new TextRun({ text: line === '' ? ' ' : line })],
        spacing: { before: i === 0 ? 120 : 0, after: i === lines.length - 1 ? 160 : 0 },
        ...indentFor(ctx),
      })
  );
}

function checkItem(block, ctx) {
  const checked = !!block.props?.checked;
  const runs = inlineToRuns(block.content, ctx, { ...blockColor(block), ...(checked ? { strike: true, color: '8A8A8A' } : {}) });
  return new Paragraph({
    children: [new TextRun({ text: checked ? '☑' : '☐', font: 'Segoe UI Symbol' }), new TextRun({ text: ' ' }), ...runs],
    indent: { left: ctx.indent + 360, hanging: 360 },
    ...blockAlign(block),
  });
}

function imageBlock(block, ctx) {
  const url = block.props?.url;
  const img = ctx.images?.[url];
  const caption = cleanXmlText(block.props?.caption);
  const align = ALIGN[block.props?.textAlignment] || AlignmentType.LEFT;
  if (!img) {
    const name = cleanXmlText(block.props?.name) || ctx.imageLabel || 'Image';
    return [new Paragraph({ children: [new ExternalHyperlink({ link: absoluteUrl(url, ctx.origin), children: [new TextRun({ text: name, color: LINK, underline: {} })] })], ...indentFor(ctx) })];
  }
  const m = /^data:image\/(png|jpeg|jpg);base64,(.*)$/s.exec(img.dataUrl || '');
  if (!m) return [];
  const data = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  const maxW = (ctx.contentWidth - ctx.indent) / 15; // twips -> px (96 dpi)
  const maxH = ctx.contentHeight / 15 - 60;
  let w = Math.min(typeof block.props?.previewWidth === 'number' ? block.props.previewWidth : img.width, maxW);
  if ((w * img.height) / img.width > maxH) w = (maxH * img.width) / img.height;
  const h = (w * img.height) / img.width;
  const out = [
    new Paragraph({
      children: [new ImageRun({ type: m[1] === 'png' ? 'png' : 'jpg', data, transformation: { width: Math.round(w), height: Math.round(h) }, altText: { title: caption || 'image', description: caption || 'image', name: 'image' } })],
      alignment: align,
      keepNext: !!caption,
      spacing: { before: 80, after: caption ? 40 : 120 },
      ...indentFor(ctx),
    }),
  ];
  if (caption) out.push(new Paragraph({ children: [new TextRun({ text: caption, italics: true, size: 18, color: '737373' })], alignment: align, spacing: { after: 120 }, ...indentFor(ctx) }));
  return out;
}

function linkBlock(block, ctx, label) {
  const name = cleanXmlText(block.props?.name) || cleanXmlText(block.props?.url) || label;
  const caption = cleanXmlText(block.props?.caption);
  const out = [new Paragraph({ children: [new ExternalHyperlink({ link: absoluteUrl(block.props?.url, ctx.origin), children: [new TextRun({ text: name, color: LINK, underline: {} })] })], ...indentFor(ctx) })];
  if (caption) out.push(new Paragraph({ children: [new TextRun({ text: caption, italics: true, size: 18, color: '737373' })], ...indentFor(ctx) }));
  return out;
}

const border = (color = RULE, size = 4) => ({ style: BorderStyle.SINGLE, size, color });

function tableBlock(block, ctx) {
  const content = block.content;
  const rows = content?.rows || [];
  if (!rows.length) return [];
  const headerRows = content.headerRows ?? 0;
  const headerCols = content.headerCols ?? 0;
  const cols = Math.max(...rows.map((r) => r.cells.reduce((n, c) => n + (c?.props?.colspan || 1), 0)));
  const available = ctx.contentWidth - ctx.indent;
  const widths = Array.from({ length: cols }, (_, i) => content.columnWidths?.[i]);
  const known = widths.every((w) => typeof w === 'number' && w > 0);
  const sum = known ? widths.reduce((a, b) => a + b, 0) : 0;
  const grid = known ? widths.map((w) => Math.round((w / sum) * available)) : widths.map(() => Math.floor(available / cols));

  const occupied = new Set();
  const tableRows = rows.map((row, r) => {
    const cells = [];
    let c = 0;
    for (const cell of row.cells) {
      while (occupied.has(`${r}:${c}`)) c++;
      const props = cell?.props || {};
      const inline = Array.isArray(cell) ? cell : cell?.content;
      const header = r < headerRows || c < headerCols;
      const colSpan = props.colspan || 1;
      const rowSpan = props.rowspan || 1;
      const base = { ...(header ? { bold: true } : {}), ...(TEXT_COLORS[props.textColor] ? { color: TEXT_COLORS[props.textColor] } : {}) };
      const fill = BG_COLORS[props.backgroundColor] || (header ? 'F4F4F5' : null);
      const width = grid.slice(c, c + colSpan).reduce((a, b) => a + b, 0);
      cells.push(
        new TableCell({
          children: [new Paragraph({ children: inlineToRuns(inline, ctx, base), spacing: { before: 20, after: 20 }, ...(ALIGN[props.textAlignment] && props.textAlignment !== 'left' ? { alignment: ALIGN[props.textAlignment] } : {}) })],
          width: { size: width, type: WidthType.DXA },
          ...(colSpan > 1 ? { columnSpan: colSpan } : {}),
          ...(rowSpan > 1 ? { rowSpan } : {}),
          ...(fill ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill } } : {}),
        })
      );
      for (let dr = 1; dr < rowSpan; dr++) for (let dc = 0; dc < colSpan; dc++) occupied.add(`${r + dr}:${c + dc}`);
      c += colSpan;
    }
    return new TableRow({ children: cells, ...(r < headerRows ? { tableHeader: true } : {}), cantSplit: true });
  });

  return [
    new Table({
      rows: tableRows,
      columnWidths: grid,
      width: { size: grid.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      ...(ctx.indent ? { indent: { size: ctx.indent, type: WidthType.DXA } } : {}),
      margins: { top: 40, bottom: 40, left: 100, right: 100 },
      borders: { top: border(), bottom: border(), left: border(), right: border(), insideHorizontal: border(), insideVertical: border() },
    }),
    new Paragraph({ children: [], spacing: { after: 80 } }), // a table is never the last thing before the next block
  ];
}

// ---------- lists ----------

const BULLETS = ['•', '◦', '▪'];

function listLevels(format, texts) {
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format,
    text: texts(level),
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 540 + 360 * level, hanging: 270 } } },
  }));
}

const NUMBER_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
const NUMBER_LEVELS = Array.from({ length: 9 }, (_, level) => ({
  level,
  format: NUMBER_FORMATS[level % 3],
  text: `%${level + 1}.`,
  alignment: AlignmentType.LEFT,
  style: { paragraph: { indent: { left: 540 + 360 * level, hanging: 360 } } },
}));

function listItem(block, ctx, kind, instance, level) {
  const out = [
    new Paragraph({
      children: inlineToRuns(block.content, ctx, blockColor(block)),
      numbering: { reference: kind === 'bullet' ? 'bullets' : 'numbers', level: Math.min(level, 8), instance },
      ...blockAlign(block),
    }),
  ];
  // Sub-items continue the list one level deeper; anything else under the item lines up with its text.
  if (block.children?.length) out.push(...renderBlocks(block.children, { ...ctx, indent: 540 + 360 * level }, level + 1));
  return out;
}

export function renderBlocks(blocks, ctx, level = 0) {
  const out = [];
  for (let i = 0; i < (blocks || []).length; i++) {
    const block = blocks[i];
    const type = block.type;

    if (type === 'bulletListItem' || type === 'toggleListItem' || type === 'numberedListItem') {
      const kind = type === 'numberedListItem' ? 'number' : 'bullet';
      const same = (t) => (kind === 'number' ? t === 'numberedListItem' : t === 'bulletListItem' || t === 'toggleListItem');
      const instance = ++ctx.counter.n; // each run of items is its own list (numbering restarts)
      while (i < blocks.length && same(blocks[i].type)) out.push(...listItem(blocks[i++], ctx, kind, instance, level));
      i--;
      continue;
    }

    switch (type) {
      case 'paragraph':
        out.push(paragraph(block, ctx));
        break;
      case 'heading':
        out.push(heading(block, ctx));
        break;
      case 'quote':
        out.push(paragraph(block, ctx, { options: { style: 'Quote' } }));
        break;
      case 'codeBlock':
        out.push(...codeBlock(block, ctx));
        break;
      case 'checkListItem':
        out.push(checkItem(block, ctx));
        break;
      case 'image':
        out.push(...imageBlock(block, ctx));
        break;
      case 'video':
        out.push(...linkBlock(block, ctx, 'Video'));
        break;
      case 'audio':
        out.push(...linkBlock(block, ctx, 'Audio'));
        break;
      case 'file':
        out.push(...linkBlock(block, ctx, 'File'));
        break;
      case 'table':
        out.push(...tableBlock(block, ctx));
        break;
      case 'divider':
        out.push(new Paragraph({ border: { bottom: border(RULE, 6) }, spacing: { before: 120, after: 160 }, ...indentFor(ctx) }));
        break;
      default:
        if (Array.isArray(block.content)) out.push(paragraph(block, ctx));
    }
    if (block.children?.length) out.push(...renderBlocks(block.children, { ...ctx, indent: ctx.indent + 360 }, level));
  }
  return out;
}

export function buildDocx(blocks, options = {}) {
  const page = PAGE[options.paper] || PAGE.A4;
  const ctx = {
    byId: options.byId || {},
    origin: options.origin || '',
    images: options.images || {},
    untitled: options.untitled,
    imageLabel: options.imageLabel,
    contentWidth: page.width - 2 * MARGIN,
    contentHeight: page.height - 2 * MARGIN,
    indent: 0,
    counter: { n: 0 },
  };
  const title = cleanXmlText(options.title || options.untitled || 'Untitled').trim();
  const lang = options.lang === 'tr' ? 'tr-TR' : 'en-US';

  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: `${options.icon ? `${cleanXmlText(options.icon)} ` : ''}${title}` })] }),
    ...renderBlocks(blocks, ctx),
  ];

  return new Document({
    creator: options.author || 'Quarc Notes',
    title,
    description: 'Exported from Quarc Notes',
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 22, language: { value: lang } }, paragraph: { spacing: { after: 120, line: 276 } } },
        title: { run: { font: BODY_FONT, size: 56, bold: true, color: '171717' }, paragraph: { spacing: { after: 240 } } },
        heading1: { run: { font: BODY_FONT, size: 48, bold: true, color: '171717' }, paragraph: { spacing: { before: 360, after: 120 }, keepNext: true } },
        heading2: { run: { font: BODY_FONT, size: 36, bold: true, color: '171717' }, paragraph: { spacing: { before: 280, after: 100 }, keepNext: true } },
        heading3: { run: { font: BODY_FONT, size: 29, bold: true, color: '171717' }, paragraph: { spacing: { before: 240, after: 80 }, keepNext: true } },
        heading4: { run: { font: BODY_FONT, size: 25, bold: true, color: '171717' }, paragraph: { spacing: { before: 200, after: 60 }, keepNext: true } },
        heading5: { run: { font: BODY_FONT, size: 23, bold: true, color: '171717' }, paragraph: { spacing: { before: 200, after: 60 }, keepNext: true } },
        heading6: { run: { font: BODY_FONT, size: 22, bold: true, color: '171717' }, paragraph: { spacing: { before: 200, after: 60 }, keepNext: true } },
      },
      paragraphStyles: [
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          quickFormat: true,
          run: { italics: true, color: '525252' },
          paragraph: { indent: { left: 360 }, spacing: { before: 80, after: 80 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: RULE, space: 10 } } },
        },
        {
          id: 'CodeBlock',
          name: 'Code Block',
          basedOn: 'Normal',
          run: { font: CODE_FONT, size: 18 },
          paragraph: { spacing: { line: 252 }, shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F4F4F5' } },
        },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: listLevels(LevelFormat.BULLET, (l) => BULLETS[l % 3]) },
        { reference: 'numbers', levels: NUMBER_LEVELS },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: page.width, height: page.height }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
        children,
      },
    ],
  });
}
