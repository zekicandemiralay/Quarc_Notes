import { db } from './db';
import { apiUrl } from './apiUrl';

let syncing = false;

async function getCursor() {
  const row = await db.meta.get('sync_cursor');
  return row?.value || '1970-01-01 00:00:00';
}

async function setCursor(value) {
  await db.meta.put({ key: 'sync_cursor', value });
}

export async function pushOutbox() {
  const pending = await db.outbox.toArray();
  if (!pending.length) return;

  const mutations = pending.map((m) => ({
    id: m.id,
    op: m.op,
    title: m.title,
    icon: m.icon,
    type: m.type,
    content_json: m.content_json,
    ink_json: m.ink_json,
    parent_id: m.parent_id,
    sort_order: m.sort_order,
    canvas_settings: m.canvas_settings,
    base_updated_at: m.base_updated_at,
  }));

  const res = await fetch(apiUrl('/api/sync/push'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ mutations }),
  });
  if (!res.ok) return;

  const { results } = await res.json();
  for (const r of results) {
    if (r.status === 'ok') {
      await db.outbox.delete(r.id);
      if (r.updated_at) await db.pages.update(r.id, { updated_at: r.updated_at });
    }
    // On conflict, leave it queued — pullFromServer() will bring the server's
    // version down next, and the user's local edit stays queued to retry.
  }
}

export async function pullFromServer() {
  const since = await getCursor();
  const res = await fetch(apiUrl(`/api/sync/pull?since=${encodeURIComponent(since)}`), { credentials: 'include' });
  if (!res.ok) return;

  const { pages, serverTime } = await res.json();
  if (pages.length) {
    await db.pages.bulkPut(pages.map((p) => ({
      ...p,
      content_json: JSON.stringify(p.content_json),
      ink_json: JSON.stringify(p.ink_json),
      canvas_settings: JSON.stringify(p.canvas_settings),
    })));
  }
  await setCursor(serverTime);
}

export async function sync() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    await pushOutbox();
    await pullFromServer();
  } catch {
    // offline or server unreachable — will retry on the next trigger
  } finally {
    syncing = false;
  }
}

export function startSyncLoop() {
  sync();
  window.addEventListener('online', sync);
  const interval = setInterval(sync, 30000);
  return () => {
    window.removeEventListener('online', sync);
    clearInterval(interval);
  };
}
