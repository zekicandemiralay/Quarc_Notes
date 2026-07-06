const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'notes.db');

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

    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      page_id UNINDEXED,
      title,
      body,
      tokenize = 'porter'
    );
  `);
}

module.exports = { getDb, initDb };
