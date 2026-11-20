import { create } from 'zustand';
import { db } from './db';
import { on } from './events';

// In-memory index of every page's metadata (no content), for the sidebar,
// home, wikilink titles and the quick switcher. Kept separate from Dexie
// live queries on purpose: those re-read every page's full content (large
// handwriting JSON) after every autosave.
export const usePageIndex = create(() => ({ pages: [], byId: {}, loaded: false }));

function strip(row) {
  const { content_json, ink_json, canvas_settings, ...meta } = row; // eslint-disable-line no-unused-vars
  return meta;
}

function publish(pages) {
  pages.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const byId = {};
  for (const p of pages) byId[p.id] = p;
  usePageIndex.setState({ pages, byId, loaded: true });
}

let reloadTimer = null;
let reloading = null;

export function reloadPageIndex({ immediate = false } = {}) {
  clearTimeout(reloadTimer);
  const run = async () => {
    reloading = db.pages.toArray().then((rows) => publish(rows.map(strip)));
    await reloading;
  };
  if (immediate) return run();
  reloadTimer = setTimeout(run, 80);
  return undefined;
}

// Cheap in-memory update after a local edit (no Dexie read).
export function patchPageMeta(id, patch) {
  const { pages } = usePageIndex.getState();
  const idx = pages.findIndex((p) => p.id === id);
  if (idx < 0) {
    reloadPageIndex();
    return;
  }
  const next = pages.slice();
  const meta = { ...next[idx] };
  for (const [k, v] of Object.entries(patch)) {
    if (k !== 'content_json' && k !== 'ink_json' && k !== 'canvas_settings') meta[k] = v;
  }
  next[idx] = meta;
  publish(next);
}

on('pages-changed', () => reloadPageIndex());

// Tree helpers.
export function childrenOf(pages, parentId) {
  return pages.filter((p) => !p.is_deleted && (p.parent_id || null) === (parentId || null));
}

export function ancestorsOf(byId, id) {
  const out = [];
  const seen = new Set();
  let cur = byId[id];
  while (cur?.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    cur = byId[cur.parent_id];
    if (!cur) break;
    out.unshift(cur);
  }
  return out;
}
