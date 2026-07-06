import { db } from './db';
import { sync } from './sync';
import { apiUrl } from './apiUrl';

const uuidv4 = () => crypto.randomUUID();

const DEFAULT_CANVAS_SETTINGS = { pageSize: 'A5', pageStyle: 'lined' };

function parse(page) {
  return {
    ...page,
    content_json: typeof page.content_json === 'string' ? JSON.parse(page.content_json) : page.content_json,
    ink_json: typeof page.ink_json === 'string' ? JSON.parse(page.ink_json) : page.ink_json,
    canvas_settings:
      typeof page.canvas_settings === 'string'
        ? JSON.parse(page.canvas_settings)
        : page.canvas_settings || DEFAULT_CANVAS_SETTINGS,
  };
}

export async function listPages({ trash = false } = {}) {
  const rows = await db.pages.where('is_deleted').equals(trash ? 1 : 0).toArray();
  return rows.map(parse).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

export async function getPage(id) {
  const row = await db.pages.get(id);
  return row ? parse(row) : null;
}

export async function getBacklinks(id) {
  try {
    const res = await fetch(apiUrl(`/api/pages/${id}/backlinks`), { credentials: 'include' });
    if (res.ok) return res.json();
  } catch {
    /* offline — no local backlink index in v1, just show none */
  }
  return [];
}

async function queueMutation(page, op = 'upsert') {
  await db.outbox.put({
    id: page.id,
    op,
    title: page.title,
    icon: page.icon,
    type: page.type,
    content_json: page.content_json,
    ink_json: page.ink_json,
    parent_id: page.parent_id,
    sort_order: page.sort_order,
    canvas_settings: page.canvas_settings,
    base_updated_at: page.updated_at,
  });
  sync();
}

export async function createPage({ title = 'Untitled', parent_id = null, type = 'doc', icon = null } = {}) {
  const now = new Date().toISOString();
  const page = {
    id: uuidv4(),
    parent_id,
    title,
    icon,
    type,
    content_json: [],
    ink_json: [],
    canvas_settings: { ...DEFAULT_CANVAS_SETTINGS },
    sort_order: Date.now(),
    is_deleted: 0,
    created_at: now,
    updated_at: now,
  };
  await db.pages.put({
    ...page,
    content_json: JSON.stringify(page.content_json),
    ink_json: JSON.stringify(page.ink_json),
    canvas_settings: JSON.stringify(page.canvas_settings),
  });
  await queueMutation(page);
  return page;
}

export async function updatePage(id, patch) {
  const existing = await getPage(id);
  const updated = { ...existing, ...patch, updated_at: new Date().toISOString() };
  await db.pages.put({
    ...updated,
    content_json: JSON.stringify(updated.content_json),
    ink_json: JSON.stringify(updated.ink_json),
    canvas_settings: JSON.stringify(updated.canvas_settings || DEFAULT_CANVAS_SETTINGS),
  });
  await queueMutation(updated);
  return updated;
}

export async function trashPage(id) {
  await db.pages.update(id, { is_deleted: 1, updated_at: new Date().toISOString() });
  await queueMutation({ id }, 'delete');
}

export async function restorePage(id) {
  const existing = await getPage(id);
  await updatePage(id, { ...existing, is_deleted: 0 });
}

export async function search(q) {
  try {
    const res = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(q)}`), { credentials: 'include' });
    if (res.ok) return res.json();
  } catch {
    /* fall through to local scan */
  }
  const all = await listPages();
  const needle = q.toLowerCase();
  return all
    .filter((p) => p.title.toLowerCase().includes(needle))
    .map((p) => ({ id: p.id, title: p.title, icon: p.icon, type: p.type, updated_at: p.updated_at, snippet: '' }));
}
