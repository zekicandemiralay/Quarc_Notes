// One-off migration: copies existing Quarc Music users into the shared Quarc Auth
// database, preserving id/password_hash/salt/role/created_at so nobody has to
// reset their password and existing JWTs (same id/username/role payload) stay valid.
//
// Usage:
//   node migrate-from-music.js /path/to/music.db
//
// Run this against a COPY of music.db, not the live file a running container is using.

const Database = require('better-sqlite3');
const path = require('path');
const { getDb, createSchema, ensureAdmin } = require('./src/db');

const musicDbPath = process.argv[2];
if (!musicDbPath) {
  console.error('Usage: node migrate-from-music.js /path/to/music.db');
  process.exit(1);
}

// Create the table only — do NOT auto-create an admin yet. If we did, Music's
// real admin username would find that placeholder already "existing" below
// and get skipped, silently discarding the real admin account.
createSchema();
const authDb = getDb();
const musicDb = new Database(path.resolve(musicDbPath), { readonly: true });

const musicUsers = musicDb.prepare('SELECT id, username, password_hash, salt, role, created_at FROM users').all();

const insert = authDb.prepare(
  'INSERT INTO users (id, username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const exists = authDb.prepare('SELECT id FROM users WHERE username = ?');

let migrated = 0;
let skipped = 0;

for (const user of musicUsers) {
  if (exists.get(user.username)) {
    skipped++;
    continue;
  }
  insert.run(user.id, user.username, user.password_hash, user.salt, user.role, user.created_at);
  migrated++;
}

console.log(`Migrated ${migrated} user(s), skipped ${skipped} already-existing username(s).`);

// Only now fall back to auto-creating an admin, and only if nothing (including
// what we just migrated) already has the admin role.
ensureAdmin(authDb);

// Checkpoint WAL into the main db file and close cleanly before the process
// exits, so the very next process to open this file (the real server,
// started right after this script) sees a fully merged, non-WAL file rather
// than relying on it finding stray -wal/-shm sidecar files.
authDb.pragma('wal_checkpoint(TRUNCATE)');
authDb.close();
musicDb.close();
