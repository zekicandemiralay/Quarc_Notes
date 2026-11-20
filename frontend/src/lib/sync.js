import { create } from 'zustand';
import { db } from './db';
import { apiUrl } from './apiUrl';
import { emit } from './events';
import { toIso } from './time';
import i18n from '../i18n';

// Offline-first sync with the server (see backend/src/routes/sync.js).
//
// Every local change goes into Dexie immediately and into the outbox (one
// entry per page, holding only the fields that changed). sync() pushes the
// outbox, then pulls whatever changed on the server since the last pull.
// Conflicts are resolved on the server without losing anything: drawings
// merge stroke by stroke, documents keep the other version as a copy.

const CLIENT_ID_KEY = 'quarc_notes_client_id';

// Identifies this device to the server, so its own back-to-back saves are
// never mistaken for a conflict with another device.
export function getClientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return 'unknown-device';
  }
}

export const useSyncStatus = create(() => ({
  state: 'idle', // 'idle' | 'syncing' | 'offline' | 'error'
  pending: 0,
  lastSyncedAt: null,
}));

async function refreshPending() {
  useSyncStatus.setState({ pending: await db.outbox.count() });
}

// Server row (parsed JSON) -> Dexie row (JSON as strings).
export function fromServer(p) {
  return {
    id: p.id,
    parent_id: p.parent_id || null,
    title: p.title ?? 'Untitled',
    icon: p.icon ?? null,
    type: p.type || 'doc',
    content_json: JSON.stringify(p.content_json ?? []),
    ink_json: JSON.stringify(p.ink_json ?? []),
    canvas_settings: JSON.stringify(p.canvas_settings ?? {}),
    sort_order: p.sort_order ?? 0,
    is_deleted: p.is_deleted ? 1 : 0,
    is_favorite: p.is_favorite ? 1 : 0,
    created_at: toIso(p.created_at),
    updated_at: toIso(p.updated_at),
    server_updated_at: p.updated_at,
  };
}

let syncing = false;
let syncAgain = false;

async function getCursor() {
  const row = await db.meta.get('sync_cursor_v2');
  return row?.value || '';
}

async function pushOutbox() {
  const pending = await db.outbox.orderBy('queued_at').toArray();
  if (!pending.length) return;

  const sentRevs = new Map(pending.map((e) => [e.id, e.rev]));
  const mutations = pending.map((e) => {
    const m = { id: e.id, base_updated_at: e.base_updated_at, fields: e.fields || {} };
    if (e.deleted !== undefined) m.deleted = e.deleted;
    if (e.purge) m.purge = true;
    return m;
  });

  const res = await fetch(apiUrl('/api/sync/push'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ client_id: getClientId(), conflict_label: i18n.t('sync.conflictCopy'), mutations }),
  });
  if (!res.ok) throw new Error(`push failed: ${res.status}`);
  const { results } = await res.json();

  const changed = [];
  const conflicts = [];
  await db.transaction('rw', db.outbox, db.pages, async () => {
    for (const r of results) {
      const entry = await db.outbox.get(r.id);
      // Edited again while this push was in flight: keep the newer entry.
      const modifiedSince = !!entry && entry.rev !== sentRevs.get(r.id);

      if (r.status === 'error') {
        // Permanent (forbidden / invalid): retrying would block the queue.
        console.warn('Sync dropped a change the server rejected', r);
        if (!modifiedSince) await db.outbox.delete(r.id);
        continue;
      }
      if (r.status !== 'ok' && r.status !== 'gone') continue;

      if (!modifiedSince) await db.outbox.delete(r.id);
      if (r.status === 'gone' || r.purged) {
        if (!modifiedSince) await db.pages.delete(r.id);
        changed.push(r.id);
        continue;
      }
      if (r.conflict_copy_id) conflicts.push(r.conflict_copy_id);

      if (modifiedSince) {
        // A merge result isn't in the newer entry yet: leave its base alone
        // so the server merges again rather than taking it as a follow-up.
        if (!r.merged) await db.outbox.update(r.id, { base_updated_at: r.updated_at });
        continue;
      }
      if (r.page) {
        const row = fromServer(r.page);
        const local = await db.pages.get(r.id);
        await db.pages.put(row);
        if (!local || local.content_json !== row.content_json || local.ink_json !== row.ink_json || local.is_deleted !== row.is_deleted || local.parent_id !== row.parent_id) {
          changed.push(r.id);
        }
      } else {
        await db.pages.update(r.id, { server_updated_at: r.updated_at });
      }
    }
  });
  if (changed.length) emit('pages-changed', changed);
  if (conflicts.length) emit('conflict-copies', conflicts);
}

async function pullFromServer() {
  const since = await getCursor();
  const res = await fetch(apiUrl(`/api/sync/pull?v=2&since=${encodeURIComponent(since)}`), { credentials: 'include' });
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  const { pages, serverTime, deleted = [] } = await res.json();

  const changed = [];
  await db.transaction('rw', db.pages, db.outbox, db.meta, async () => {
    for (const p of pages) {
      // Local changes still queued: keep them. The push answers with the
      // server's version if this copy was out of date.
      if (await db.outbox.get(p.id)) continue;
      const local = await db.pages.get(p.id);
      if (local && local.server_updated_at === p.updated_at) continue;
      await db.pages.put(fromServer(p));
      changed.push(p.id);
    }
    for (const id of deleted) {
      if (await db.outbox.get(id)) continue;
      if (await db.pages.get(id)) {
        await db.pages.delete(id);
        changed.push(id);
      }
    }
    await db.meta.put({ key: 'sync_cursor_v2', value: serverTime });
  });
  if (changed.length) emit('pages-changed', changed);
}

export async function sync() {
  if (syncing) {
    syncAgain = true;
    return;
  }
  if (!navigator.onLine) {
    useSyncStatus.setState({ state: 'offline' });
    await refreshPending();
    return;
  }
  syncing = true;
  useSyncStatus.setState({ state: 'syncing' });
  try {
    do {
      syncAgain = false;
      await pushOutbox();
      await pullFromServer();
    } while (syncAgain);
    useSyncStatus.setState({ state: 'idle', lastSyncedAt: new Date().toISOString() });
  } catch {
    // Offline or server unreachable — retried on the next trigger.
    useSyncStatus.setState({ state: navigator.onLine ? 'error' : 'offline' });
  } finally {
    syncing = false;
    await refreshPending();
  }
}

// Debounced trigger for local edits: typing doesn't fire a request per key.
let soonTimer = null;
export function syncSoon(delay = 1500) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(sync, delay);
  refreshPending();
}

export function startSyncLoop() {
  sync();
  const onOnline = () => sync();
  const onOffline = () => useSyncStatus.setState({ state: 'offline' });
  const onVisible = () => {
    if (document.visibilityState === 'visible') sync();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  const interval = setInterval(sync, 20000);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(interval);
  };
}

// Wipes the local cache (used on logout / account switch, so the next
// account never sees the previous one's notes).
export async function clearLocalData() {
  await db.transaction('rw', db.pages, db.outbox, db.meta, async () => {
    await db.pages.clear();
    await db.outbox.clear();
    await db.meta.clear();
  });
  await refreshPending();
  emit('pages-changed', []);
}
