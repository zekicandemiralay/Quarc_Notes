// Helpers for working with a BlockNote document (an array of blocks, each with
// `content` = inline nodes and `children` = nested blocks). Wikilinks are stored
// as an inline node `{ type: 'wikilink', props: { pageId } }` carrying a resolved
// target page id (not the raw title), so renaming a page never breaks its links.

function extractText(blocks) {
  if (!Array.isArray(blocks)) return '';
  let out = [];
  for (const block of blocks) {
    if (Array.isArray(block.content)) {
      for (const inline of block.content) {
        if (inline.type === 'text' && typeof inline.text === 'string') out.push(inline.text);
      }
    }
    if (Array.isArray(block.children) && block.children.length) {
      out.push(extractText(block.children));
    }
  }
  return out.join(' ');
}

function extractWikilinkIds(blocks) {
  const ids = new Set();
  if (!Array.isArray(blocks)) return ids;
  for (const block of blocks) {
    if (Array.isArray(block.content)) {
      for (const inline of block.content) {
        if (inline.type === 'wikilink' && inline.props?.pageId) ids.add(inline.props.pageId);
      }
    }
    if (Array.isArray(block.children) && block.children.length) {
      for (const id of extractWikilinkIds(block.children)) ids.add(id);
    }
  }
  return ids;
}

module.exports = { extractText, extractWikilinkIds };
