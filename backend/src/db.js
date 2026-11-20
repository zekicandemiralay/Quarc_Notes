const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'notes.db');

// Millisecond-precision UTC timestamp, e.g. "2026-11-19 12:00:00.123".
// Older rows carry second precision ("2026-11-19 12:00:00"); both compare
// correctly as strings (a value is always a prefix-or-smaller of the same
// moment with milliseconds), which is all the sync code relies on. Second
// precision alone let a pull miss a write landing in the same second as the
// pull's own cursor.
const NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

const DEFAULT_CANVAS_SETTINGS = '{"pageSize":"A5","pageStyle":"lined","pageCount":1}';

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// For tests: point at a fresh database file.
function resetDbForTests(file) {
  if (db) db.close();
  db = null;
  process.env.DB_PATH = file;
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initDb() {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Untitled',
      icon TEXT,
      type TEXT NOT NULL DEFAULT 'doc',
      content_json TEXT DEFAULT '[]',
      ink_json TEXT DEFAULT '[]',
      sort_order INTEGER DEFAULT 0,
      is_deleted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pages_user ON pages(user_id);
    CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS links (
      source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      target_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      PRIMARY KEY (source_page_id, target_page_id)
    );
    CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_page_id);

    CREATE TABLE IF NOT EXISTS tags (
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (page_id, tag)
    );
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_filepath ON attachments(filepath);

    -- Pages deleted forever. Lets every other device drop its local copy on
    -- the next pull (a hard delete otherwise leaves nothing to sync), and
    -- stops a device that was offline at the time from resurrecting it.
    CREATE TABLE IF NOT EXISTS deleted_pages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deleted_pages_user ON deleted_pages(user_id, deleted_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      page_id UNINDEXED,
      title,
      body,
      tokenize = 'porter'
    );
  `);

  // Columns added after the table already existed in production —
  // CREATE TABLE IF NOT EXISTS above won't add them to existing databases.
  const pageCols = database.pragma('table_info(pages)').map((c) => c.name);
  if (!pageCols.includes('canvas_settings')) {
    database.exec(`ALTER TABLE pages ADD COLUMN canvas_settings TEXT DEFAULT '{"pageSize":"A5","pageStyle":"lined"}'`);
  }
  if (!pageCols.includes('is_favorite')) {
    database.exec('ALTER TABLE pages ADD COLUMN is_favorite INTEGER DEFAULT 0');
  }
  // When the page's *content* (document blocks or drawing) last changed, and
  // which device changed it. Conflict detection looks only at these, so a
  // rename on one device never collides with writing on another, and a
  // device's own back-to-back saves never collide with each other.
  if (!pageCols.includes('content_updated_at')) {
    database.exec('ALTER TABLE pages ADD COLUMN content_updated_at TEXT');
    database.exec('UPDATE pages SET content_updated_at = updated_at WHERE content_updated_at IS NULL');
  }
  if (!pageCols.includes('last_client_id')) {
    database.exec('ALTER TABLE pages ADD COLUMN last_client_id TEXT');
  }
}

module.exports = { getDb, initDb, resetDbForTests, NOW, DEFAULT_CANVAS_SETTINGS };
