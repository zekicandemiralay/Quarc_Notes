import Dexie from 'dexie';
import { isServerTs, toIso } from './time';

// Local offline cache + outbox. `pages` mirrors the server's pages (JSON
// columns kept as strings); `outbox` holds at most one pending change per
// page until it reaches the server via /api/sync/push.
//
// pages row:  { id, parent_id, title, icon, type, content_json, ink_json,
//               canvas_settings, sort_order, is_deleted, is_favorite,
//               created_at, updated_at (ISO, for display/sorting),
//               server_updated_at (the server version this copy is based on) }
// outbox row: { id, rev, queued_at, base_updated_at,
//               fields: { ...only the fields that changed },
//               deleted?: true|false, purge?: true }
export const db = new Dexie('quarc-notes');

db.version(1).stores({
  pages: 'id, parent_id, updated_at, is_deleted',
  outbox: 'id',
  meta: 'key',
});

db.version(2)
  .stores({
    pages: 'id, parent_id, updated_at, is_deleted',
    outbox: 'id, queued_at',
    meta: 'key',
  })
  .upgrade(async (tx) => {
    await tx
      .table('pages')
      .toCollection()
      .modify((p) => {
        if (p.server_updated_at === undefined) p.server_updated_at = isServerTs(p.updated_at) ? p.updated_at : null;
        p.updated_at = toIso(p.updated_at);
        p.created_at = toIso(p.created_at);
        if (p.is_favorite === undefined) p.is_favorite = 0;
      });
    // Edits queued by the previous app version (whole-page snapshots) become
    // v2 entries; with no trustworthy base they overwrite, as they did before.
    let n = 0;
    await tx
      .table('outbox')
      .toCollection()
      .modify((e) => {
        if (e.fields) return;
        const legacy = { ...e };
        for (const key of Object.keys(e)) delete e[key];
        e.id = legacy.id;
        e.rev = 1;
        e.queued_at = Date.now() + n++;
        e.base_updated_at = null;
        if (legacy.op === 'delete') {
          e.fields = {};
          e.deleted = true;
        } else {
          e.fields = {};
          for (const key of ['title', 'icon', 'type', 'content_json', 'ink_json', 'parent_id', 'sort_order', 'canvas_settings']) {
            if (legacy[key] !== undefined) e.fields[key] = legacy[key];
          }
        }
      });
  });
