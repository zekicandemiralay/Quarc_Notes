// Run: npm test (from frontend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { zipBytes, crc32 } from '../src/lib/export/zip.js';
import { docToPdfDefinition, blocksToPlainText, cleanText, imageUrls, hasEmoji, inlineToSpans } from '../src/lib/export/docToPdf.js';
import monoBase64 from '../src/lib/export/fonts/robotoMonoRegular.js';

const require = createRequire(import.meta.url);

// ---------- zip ----------

// A tiny reader (central directory) to check what the writer produced.
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (dv.getUint32(end, true) !== 0x06054b50) end--;
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const dataStart = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(dataStart, dataStart + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out[name] = data;
    p += 46 + nameLen;
  }
  return out;
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip round-trips names (incl. non-ASCII) and bytes', () => {
  const bin = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
  const files = readZip(zipBytes([
    { name: 'Notlarım.md', data: '# Merhaba İstanbul ğüşıöç\n' },
    { name: 'assets/image-1.png', data: bin },
    { name: 'empty.txt', data: '' },
  ]));
  assert.deepEqual(Object.keys(files), ['Notlarım.md', 'assets/image-1.png', 'empty.txt']);
  assert.equal(new TextDecoder().decode(files['Notlarım.md']), '# Merhaba İstanbul ğüşıöç\n');
  assert.deepEqual([...files['assets/image-1.png']], [...bin]);
  assert.equal(files['empty.txt'].length, 0);
});

// ---------- document -> PDF definition ----------

const T = (text, styles = {}) => ({ type: 'text', text, styles });
const block = (type, content, props = {}, children = []) => ({ id: Math.random().toString(36), type, props, content, children });
const ctxFor = { untitled: 'Untitled' };

const sample = [
  block('heading', [T('Başlık Çok Güzel')], { level: 1 }),
  block('paragraph', [T('Normal, '), T('bold', { bold: true }), T(' '), T('italic', { italic: true }), T(' '), T('code', { code: true }), T(' '), T('red', { textColor: 'red' })]),
  block('paragraph', [{ type: 'link', href: 'https://example.com', content: [T('a link')] }, T(' and a '), { type: 'wikilink', props: { pageId: 'p1', title: 'Old title' } }]),
  block('bulletListItem', [T('one')], {}, [block('bulletListItem', [T('nested')])]),
  block('bulletListItem', [T('two')]),
  block('numberedListItem', [T('first')]),
  block('numberedListItem', [T('second')]),
  block('checkListItem', [T('done')], { checked: true }),
  block('checkListItem', [T('todo')], { checked: false }),
  block('quote', [T('A quote')]),
  block('codeBlock', [T('const a = 1;\n  return a;')]),
  block('divider', undefined),
  block('table', { type: 'tableContent', columnWidths: [100, 200], headerRows: 1, rows: [{ cells: [[T('H1')], [T('H2')]] }, { cells: [[T('a')], [T('b')]] }] }),
  block('image', undefined, { url: '/api/attachments/x/a.png', caption: 'A caption', previewWidth: 400 }),
  block('paragraph', [T('Emoji 😀 gone, but arrows → stay')]),
];

test('every block type becomes something a PDF can show', () => {
  const images = { '/api/attachments/x/a.png': { dataUrl: 'data:image/png;base64,AAAA', width: 800, height: 400 } };
  const def = docToPdfDefinition(sample, { title: '📝 My note', paper: 'A4', byId: { p1: { title: 'New title' } }, images, untitled: 'Untitled' });
  assert.equal(def.pageSize.width, 595.28);
  const kinds = def.content.map((n) => Object.keys(n).find((k) => ['text', 'ul', 'ol', 'table', 'columns', 'canvas', 'stack', 'image'].includes(k)));
  // title, heading, 2 paragraphs, ul, ol, 2 checks, quote, code, divider, table, image, paragraph
  assert.deepEqual(kinds, ['text', 'text', 'text', 'text', 'ul', 'ol', 'columns', 'columns', 'table', 'table', 'canvas', 'table', 'stack', 'text']);
  const json = JSON.stringify(def);
  assert.ok(json.includes('Başlık Çok Güzel'), 'Turkish text kept');
  assert.ok(json.includes('New title') && !json.includes('Old title'), 'wikilink shows the current title');
  assert.ok(json.includes('https://example.com'));
  assert.ok(!json.includes('😀'), 'emoji dropped');
  assert.ok(json.includes('arrows → stay'));
  assert.ok(json.includes('A caption'));
  // Wide table scaled to the page, not wider.
  const table = def.content.find((n) => n.table?.headerRows === 1);
  const widths = table.table.widths;
  assert.ok(Math.abs(widths[0] / widths[1] - 0.5) < 1e-9);
  assert.ok(widths[0] + widths[1] < 595.28 - 112);
  // A heading is never alone at the bottom of a page.
  assert.equal(def.pageBreakBefore({ headlineLevel: 2 }, []), true);
  assert.equal(def.pageBreakBefore({ headlineLevel: 2 }, [{}]), false);
  assert.equal(def.pageBreakBefore({}, []), false);
});

test('an image that could not be loaded becomes a link, not a hole', () => {
  const def = docToPdfDefinition([block('image', undefined, { url: '/api/attachments/x/b.png', name: 'photo.png' })], { title: 't', origin: 'https://notes.example' });
  const json = JSON.stringify(def);
  assert.ok(json.includes('photo.png') && json.includes('https://notes.example/api/attachments/x/b.png'));
});

test('letter paper changes the page; images are collected from nested blocks', () => {
  const nested = [block('paragraph', [T('x')], {}, [block('image', undefined, { url: 'u1' }), block('bulletListItem', [T('y')], {}, [block('image', undefined, { url: 'u2' })])])];
  assert.deepEqual(imageUrls(nested).sort(), ['u1', 'u2']);
  assert.equal(docToPdfDefinition([], { title: 't', paper: 'Letter' }).pageSize.width, 612);
});

test('cleanText drops emoji but keeps Turkish letters and arrows', () => {
  assert.equal(cleanText('Çalışma 🎉 günlüğü ✅ → ok x'), 'Çalışma  günlüğü  → ok x');
  assert.ok(hasEmoji('📝') && hasEmoji('🚀 launch') && !hasEmoji('plain'));
  assert.deepEqual(inlineToSpans([T('🙂')], {}), []);
});

test('plain text export keeps structure', () => {
  const text = blocksToPlainText(sample, { byId: { p1: { title: 'New title' } } });
  for (const line of ['BAŞLIK ÇOK GÜZEL', '- one', '  - nested', '1. first', '2. second', '[x] done', '[ ] todo', '> A quote', '    const a = 1;', '---', 'H1\tH2', 'a link and a [[New title]]']) {
    assert.ok(text.includes(line), `missing: ${line}`);
  }
});

// ---------- the real PDF library, in Node ----------

test('pdfmake turns a full document into a multi-page PDF (Turkish text, code, tables, lists)', async () => {
  const pdfmake = require('pdfmake');
  const robotoDir = require.resolve('pdfmake/package.json').replace(/package\.json$/, 'build/fonts/Roboto/');
  const fs = require('node:fs');
  const font = (f) => fs.readFileSync(robotoDir + f);
  const mono = Buffer.from(monoBase64, 'base64');
  pdfmake.setFonts({
    Roboto: { normal: font('Roboto-Regular.ttf'), bold: font('Roboto-Medium.ttf'), italics: font('Roboto-Italic.ttf'), bolditalics: font('Roboto-MediumItalic.ttf') },
    Mono: { normal: mono, bold: mono, italics: mono, bolditalics: mono },
  });
  // Enough content for several pages, including a code listing longer than a page.
  const long = [];
  for (let i = 0; i < 60; i++) long.push(block('paragraph', [T(`Paragraf ${i}: şğüıöç İĞÜŞÖÇ — ` + 'lorem ipsum dolor sit amet '.repeat(8))]));
  long.push(block('codeBlock', [T(Array.from({ length: 150 }, (_, i) => `line ${i}   indented`).join('\n'))]));
  long.push(block('heading', [T('Son')], { level: 2 }));
  const def = docToPdfDefinition([...sample.filter((b) => b.type !== 'image'), ...long], { title: 'Test', untitled: 'Untitled' });
  const buffer = await pdfmake.createPdf(def).getBuffer();
  const head = Buffer.from(buffer.slice(0, 5)).toString();
  assert.equal(head, '%PDF-');
  const pages = (Buffer.from(buffer).toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  assert.ok(pages >= 4, `expected several pages, got ${pages}`);
  assert.ok(buffer.length < 400 * 1024, `PDF should stay small, was ${buffer.length}`);
});
