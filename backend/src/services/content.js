// Helpers for working with page content.
//
// Documents are BlockNote documents: an array of blocks, each with `content`
// (inline nodes — or, for tables, `{ type: 'tableContent', rows: [...] }`)
// and `children` (nested blocks). Wikilinks are inline nodes
// `{ type: 'wikilink', props: { pageId, title } }` carrying the target page's
// id (not its title), so renaming a page never breaks links to it.
//
// Drawings ("canvas" pages) are Excalidraw scenes: `{ elements, appState }`.

// Walks every nested object/array (blocks, inline content, links' inner
// content, table rows/cells, children) and calls visit() on each object.
// Generic on purpose: BlockNote nests text in several shapes, and a
// hand-written walker for each was what made table and link text
// unsearchable before.
function walk(node, visit, depth = 0) {
  if (depth > 64 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1);
    return;
  }
  visit(node);
  for (const key of ['content', 'children', 'rows', 'cells']) {
    if (node[key] !== undefined) walk(node[key], visit, depth + 1);
  }
}

function extractText(blocks) {
  const out = [];
  walk(blocks, (node) => {
    if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
    else if (node.type === 'wikilink' && typeof node.props?.title === 'string') out.push(node.props.title);
    // File/image/video blocks: their caption and file name are searchable too.
    if (node.props && typeof node.props === 'object') {
      if (typeof node.props.caption === 'string' && node.props.caption) out.push(node.props.caption);
      if (typeof node.props.name === 'string' && node.props.name) out.push(node.props.name);
    }
  });
  return out.join(' ');
}

// Typed text on a drawing (Excalidraw text elements), so handwritten
// notebooks with labels/headings show up in search too.
function extractCanvasText(ink) {
  const elements = Array.isArray(ink?.elements) ? ink.elements : [];
  return elements
    .filter((el) => el && !el.isDeleted && el.type === 'text')
    .map((el) => el.originalText || el.text || '')
    .filter(Boolean)
    .join(' ');
}

function extractWikilinkIds(blocks) {
  const ids = new Set();
  walk(blocks, (node) => {
    if (node.type === 'wikilink' && typeof node.props?.pageId === 'string' && node.props.pageId) {
      ids.add(node.props.pageId);
    }
  });
  return ids;
}

// Element-level merge of two versions of the same drawing, for when two
// devices drew on it independently (e.g. one of them offline). Excalidraw
// bumps an element's `version` on every change, so per element id the
// higher version is the newer edit; equal versions tie-break on the lower
// `versionNonce` — the same rule Excalidraw's own collaboration uses, so
// both sides of a merge always agree. Deletions are elements with
// isDeleted: true and a bumped version, so they merge the same way. The
// result keeps every stroke either side drew: nothing is lost.
function elementWins(a, b) {
  const va = a.version ?? 0;
  const vb = b.version ?? 0;
  if (va !== vb) return va > vb;
  return (a.versionNonce ?? 0) < (b.versionNonce ?? 0);
}

function mergeScenes(serverInk, clientInk) {
  // The pre-Excalidraw format was a bare array of strokes; it has no
  // per-element versions to merge on, so the incoming copy wins.
  if (!serverInk || Array.isArray(serverInk) || !Array.isArray(serverInk.elements)) return clientInk;
  if (!clientInk || Array.isArray(clientInk) || !Array.isArray(clientInk.elements)) return serverInk;

  const byId = new Map();
  const order = [];
  for (const el of serverInk.elements) {
    if (!el || typeof el.id !== 'string') continue;
    if (!byId.has(el.id)) order.push(el.id);
    byId.set(el.id, el);
  }
  for (const el of clientInk.elements) {
    if (!el || typeof el.id !== 'string') continue;
    const prev = byId.get(el.id);
    if (!prev) {
      order.push(el.id);
      byId.set(el.id, el);
    } else if (elementWins(el, prev)) {
      byId.set(el.id, el);
    }
  }
  const elements = order.map((id) => byId.get(id));
  // Excalidraw stores z-order as fractional-index strings; keep it.
  if (elements.every((el) => typeof el.index === 'string')) {
    elements.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  }
  // Images placed on the drawing (Excalidraw "files"): keep both sides'.
  const files = { ...(serverInk.files || {}), ...(clientInk.files || {}) };
  return { ...serverInk, ...clientInk, elements, files };
}

module.exports = { extractText, extractCanvasText, extractWikilinkIds, mergeScenes };
