const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'auth.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function createSchema() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return database;
}

function initDb() {
  const database = createSchema();
  ensureAdmin(database);
}

function ensureAdmin(database) {
  const existing = database.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get();
  if (existing.c > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;

  if (!password) {
    password = crypto.randomBytes(12).toString('hex');
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║    Admin account created automatically    ║');
    console.log(`║    Username : ${username.padEnd(26)}║`);
    console.log(`║    Password : ${password.padEnd(26)}║`);
    console.log('║    Save this — it will not show again     ║');
    console.log('╚══════════════════════════════════════════╝\n');
  }

  const salt = crypto.randomBytes(32).toString('hex');
  const hash = bcrypt.hashSync(password, 12);

  database.prepare(
    'INSERT INTO users (id, username, password_hash, salt, role) VALUES (?, ?, ?, ?, ?)'
  ).run(uuidv4(), username, hash, salt, 'admin');
}

module.exports = { getDb, initDb, createSchema, ensureAdmin };
