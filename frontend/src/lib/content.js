// Client copies of backend/src/services/content.js helpers (keep in step):
// generic walk over BlockNote documents, so table cells, link text and
// nested blocks are all covered.
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

export function extractText(blocks) {
  const out = [];
  walk(blocks, (node) => {
    if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
    else if (node.type === 'wikilink' && typeof node.props?.title === 'string') out.push(node.props.title);
  });
  return out.join(' ');
}

export function extractWikilinkIds(blocks) {
  const ids = new Set();
  walk(blocks, (node) => {
    if (node.type === 'wikilink' && node.props?.pageId) ids.add(node.props.pageId);
  });
  return ids;
}

export function countWords(blocks) {
  const text = extractText(blocks).trim();
  return text ? text.split(/\s+/).length : 0;
}
