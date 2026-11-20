import { db } from './db';
import { syncSoon, clearLocalData } from './sync';
import { apiUrl } from './apiUrl';
import { extractText, extractWikilinkIds } from './content';
import { reloadPageIndex, patchPageMeta } from './pageIndex';

const uuidv4 = () => crypto.randomUUID();

export const DEFAULT_CANVAS_SETTINGS = { pageSize: 'A5', pageStyle: 'lined', pageCount: 1 };

function parseJson(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Dexie row -> page object (JSON parsed).
export function parsePage(row) {
  if (!row) return null;
  return {
    ...row,
    content_json: parseJson(row.content_json, []),
    ink_json: parseJson(row.ink_json, []),
    canvas_settings: { ...DEFAULT_CANVAS_SETTINGS, ...parseJson(row.canvas_settings, {}) },
  };
}

const JSON_FIELDS = new Set(['content_json', 'ink_json', 'canvas_settings']);

function toRowValue(key, value) {
  return JSON_FIELDS.has(key) ? JSON.stringify(value ?? (key === 'canvas_settings' ? {} : [])) : value;
}

// Records a change in the outbox, merged into any change already waiting
// for that page (only changed fields are sent, so edits of different
// fields on different devices don't overwrite each other).
async function queue(id, { fields = {}, deleted, purge, base } = {}) {
  await db.transaction('rw', db.outbox, db.pages, async () => {
    const existing = await db.outbox.get(id);
    const row = await db.pages.get(id);
    const entry = existing || {
      id,
      rev: 0,
      queued_at: Date.now(),
      base_updated_at: base !== undefined ? base : row?.server_updated_at ?? null,
      fields: {},
    };
    entry.rev += 1;
    entry.fields = { ...entry.fields, ...fields };
    if (deleted !== undefined) entry.deleted = deleted;
    if (purge) entry.purge = true;
    await db.outbox.put(entry);
  });
  syncSoon();
}

export async function listPages({ trash = false } = {}) {
  const rows = await db.pages.where('is_deleted').equals(trash ? 1 : 0).toArray();
  return rows.map(parsePage).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

// Lightweight list for the sidebar/home (no content parsing).
export async function listPageMeta({ trash = false } = {}) {
  const rows = await db.pages.where('is_deleted').equals(trash ? 1 : 0).toArray();
  return rows
    .map(({ content_json, ink_json, ...meta }) => meta) // eslint-disable-line no-unused-vars
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

export async function getPage(id) {
  return parsePage(await db.pages.get(id));
}

export async function createPage({ title = '', parent_id = null, type = 'doc', icon = null, content_json = [], ink_json = null, canvas_settings = null, sort_order } = {}) {
  const now = new Date().toISOString();
  const page = {
    id: uuidv4(),
    parent_id,
    title,
    icon,
    type,
    content_json,
    ink_json: ink_json ?? (type === 'canvas' ? { elements: [], appState: {} } : []),
    canvas_settings: { ...DEFAULT_CANVAS_SETTINGS, ...(canvas_settings || {}) },
    sort_order: sort_order ?? Date.now(),
    is_deleted: 0,
    is_favorite: 0,
    created_at: now,
    updated_at: now,
    server_updated_at: null,
  };
  await db.pages.put({
    ...page,
    content_json: JSON.stringify(page.content_json),
    ink_json: JSON.stringify(page.ink_json),
    canvas_settings: JSON.stringify(page.canvas_settings),
  });
  const { id, is_deleted, created_at, updated_at, server_updated_at, ...fields } = page; // eslint-disable-line no-unused-vars
  await queue(id, { fields, base: null });
  await reloadPageIndex({ immediate: true });
  return page;
}

// `opts.base`: the server version the caller's content was built on (the
// editors pass the version they loaded), so a change made on another device
// in the meantime is detected as a conflict instead of silently replaced.
export async function updatePage(id, patch, opts = {}) {
  const row = await db.pages.get(id);
  if (!row) return null;
  const rowPatch = { updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(patch)) rowPatch[key] = toRowValue(key, value);
  await db.pages.update(id, rowPatch);
  await queue(id, { fields: patch, base: opts.base });
  patchPageMeta(id, { ...patch, updated_at: rowPatch.updated_at });
  return parsePage({ ...row, ...rowPatch });
}

async function subtreeIds(id) {
  const all = await db.pages.toArray();
  const byParent = new Map();
  for (const p of all) {
    if (!byParent.has(p.parent_id)) byParent.set(p.parent_id, []);
    byParent.get(p.parent_id).push(p.id);
  }
  const out = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur);
    stack.push(...(byParent.get(cur) || []));
  }
  return out;
}

export async function trashPage(id) {
  const ids = await subtreeIds(id);
  const now = new Date().toISOString();
  await db.pages.where('id').anyOf(ids).modify({ is_deleted: 1, updated_at: now });
  await queue(id, { deleted: true });
  await reloadPageIndex({ immediate: true });
}

export async function restorePage(id) {
  const ids = await subtreeIds(id);
  const page = await db.pages.get(id);
  const patch = { is_deleted: 0, updated_at: new Date().toISOString() };
  await db.pages.where('id').anyOf(ids).modify(patch);
  if (page?.parent_id) {
    const parent = await db.pages.get(page.parent_id);
    if (!parent || parent.is_deleted) await db.pages.update(id, { parent_id: null });
  }
  await queue(id, { deleted: false });
  await reloadPageIndex({ immediate: true });
}

export async function purgePage(id) {
  const ids = await subtreeIds(id);
  await db.pages.where('id').anyOf(ids).delete();
  // Edits still queued for the sub-pages are moot now.
  await db.outbox.where('id').anyOf(ids.filter((x) => x !== id)).delete();
  await queue(id, { purge: true });
  await reloadPageIndex({ immediate: true });
}

export async function emptyTrash() {
  const trashed = await db.pages.where('is_deleted').equals(1).toArray();
  const ids = new Set(trashed.map((p) => p.id));
  // Only the top-most trashed pages: purging them takes their sub-pages along.
  for (const p of trashed) {
    if (!p.parent_id || !ids.has(p.parent_id)) await purgePage(p.id);
  }
}

export async function setFavorite(id, value) {
  await updatePage(id, { is_favorite: value ? 1 : 0 });
}

export async function movePage(id, parentId, sortOrder) {
  if (parentId && (await subtreeIds(id)).includes(parentId)) return false; // can't move into itself
  const patch = { parent_id: parentId || null };
  if (sortOrder !== undefined) patch.sort_order = sortOrder;
  await updatePage(id, patch);
  return true;
}

// Copies a page (and, optionally, its whole subtree) as new pages.
export async function duplicatePage(id, { titleSuffix = ' (copy)', withChildren = true } = {}) {
  const source = await getPage(id);
  if (!source) return null;
  const copy = await createPage({
    title: `${source.title || ''}${titleSuffix}`,
    parent_id: source.parent_id,
    type: source.type,
    icon: source.icon,
    content_json: source.content_json,
    ink_json: source.ink_json,
    canvas_settings: source.canvas_settings,
    sort_order: (source.sort_order || 0) + 0.5,
  });
  if (withChildren) {
    const kids = (await db.pages.where('parent_id').equals(id).toArray()).filter((p) => !p.is_deleted);
    for (const kid of kids) {
      const kidCopy = await duplicatePage(kid.id, { titleSuffix: '', withChildren: true });
      if (kidCopy) await movePage(kidCopy.id, copy.id, kid.sort_order);
    }
  }
  return copy;
}

// Pages linking to `id`, computed from the local cache so it works offline
// and updates as soon as a link is typed.
export async function getBacklinks(id) {
  const rows = await db.pages.where('is_deleted').equals(0).toArray();
  return rows
    .filter((p) => p.id !== id && p.type !== 'canvas' && p.content_json?.includes(id))
    .filter((p) => extractWikilinkIds(parseJson(p.content_json, [])).has(id))
    .map((p) => ({ id: p.id, title: p.title, icon: p.icon, type: p.type }));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function localSnippet(text, needle) {
  const i = text.toLowerCase().indexOf(needle);
  if (i < 0) return '';
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + needle.length + 60);
  return (
    (start > 0 ? '…' : '') +
    escapeHtml(text.slice(start, i)) +
    '<mark>' +
    escapeHtml(text.slice(i, i + needle.length)) +
    '</mark>' +
    escapeHtml(text.slice(i + needle.length, end)) +
    (end < text.length ? '…' : '')
  );
}

// Searches the local cache (titles + text, works offline), then merges in
// the server's full-text results (ranked, stemmed) when reachable.
export async function search(q, { server = true } = {}) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const rows = await db.pages.where('is_deleted').equals(0).toArray();
  const local = [];
  for (const p of rows) {
    const titleHit = (p.title || '').toLowerCase().includes(needle);
    let snippet = '';
    if (p.type !== 'canvas') {
      const text = extractText(parseJson(p.content_json, []));
      snippet = localSnippet(text, needle);
    }
    if (titleHit || snippet) {
      local.push({ id: p.id, title: p.title, icon: p.icon, type: p.type, updated_at: p.updated_at, snippet, score: titleHit ? 2 : 1 });
    }
  }
  local.sort((a, b) => b.score - a.score || (b.updated_at || '').localeCompare(a.updated_at || ''));

  if (!server) return local;
  try {
    const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(q)}`), { credentials: 'include' });
    if (res.ok) {
      const remote = await res.json();
      const seen = new Set(local.map((r) => r.id));
      const live = new Set(rows.map((r) => r.id));
      for (const r of remote) {
        if (!seen.has(r.id) && live.has(r.id)) local.push({ ...r, score: 0 });
        else if (seen.has(r.id) && r.snippet) {
          const hit = local.find((x) => x.id === r.id);
          if (!hit.snippet) hit.snippet = r.snippet;
        }
      }
    }
  } catch {
    /* offline — local results only */
  }
  return local;
}

// Uploads a file attached to a page; returns its (server-relative) URL.
export async function uploadAttachment(pageId, file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(apiUrl(`/api/attachments/${pageId}`), { method: 'POST', credentials: 'include', body: form });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return (await res.json()).url;
}

// The local cache belongs to one account. Signing in as someone else on
// this device (here or through Quarc Store) starts from a clean cache, so
// nobody ever sees — or uploads — another account's notes.
export async function ensureLocalOwner(userId) {
  const owner = (await db.meta.get('owner'))?.value;
  if (owner === userId) return;
  if (owner) await clearLocalData();
  await db.meta.put({ key: 'owner', value: userId });
}
