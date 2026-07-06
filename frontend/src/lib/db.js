import Dexie from 'dexie';

// Local offline cache + outbox queue. Pages mirrors a subset of the server's
// `pages` table; outbox holds pending mutations made while offline until they
// can be pushed via /api/sync/push.
export const db = new Dexie('quarc-notes');

db.version(1).stores({
  pages: 'id, parent_id, updated_at, is_deleted',
  outbox: 'id',
  meta: 'key',
});
