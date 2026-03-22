const Database = require('better-sqlite3');
const { mkdirSync } = require('fs');
const { join } = require('path');

let db;

function getDb() {
  if (db) return db;

  const dbPath = join(__dirname, 'data', 'selfbase.db');
  mkdirSync(join(__dirname, 'data'), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS databases (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      host      TEXT DEFAULT 'localhost',
      port      INTEGER DEFAULT 5432,
      db_name   TEXT NOT NULL,
      username  TEXT DEFAULT 'postgres',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backups (
      id            TEXT PRIMARY KEY,
      database_id   TEXT NOT NULL,
      filename      TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      size_bytes    INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'running',
      started_at    TEXT DEFAULT (datetime('now')),
      completed_at  TEXT,
      duration_ms   INTEGER DEFAULT 0,
      error         TEXT,
      FOREIGN KEY (database_id) REFERENCES databases(id)
    );
    CREATE INDEX IF NOT EXISTS idx_backups_db ON backups(database_id);
    CREATE INDEX IF NOT EXISTS idx_backups_status ON backups(status);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed default settings
  const defaults = {
    retention_count: '10',
    retention_days: '30',
    backup_format: 'custom',
    pg_bin_path: process.env.PG_BIN_PATH || 'C:/Program Files/PostgreSQL/16/bin',
  };

  const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) {
    upsert.run(k, v);
  }

  return db;
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

module.exports = { getDb, getSetting, setSetting, getAllSettings };
