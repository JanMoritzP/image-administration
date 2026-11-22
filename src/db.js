// SQLite storage (node:sqlite, no native dependencies). One file holds project data, sprites, paths and the image bytes.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT ''
);

-- one row per requested image ("sprite"): what it shows and what it must look like
CREATE TABLE IF NOT EXISTS sprites (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1,
  tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', spec TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- the paths an image is served under (GET /files/<path>); globally unique
CREATE TABLE IF NOT EXISTS targets (
  path TEXT PRIMARY KEY, sprite_id TEXT NOT NULL REFERENCES sprites(id) ON DELETE CASCADE ON UPDATE CASCADE,
  label TEXT, position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS targets_sprite ON targets(sprite_id);

-- the current image of a sprite
CREATE TABLE IF NOT EXISTS images (
  sprite_id TEXT PRIMARY KEY REFERENCES sprites(id) ON DELETE CASCADE,
  data BLOB NOT NULL, format TEXT NOT NULL, width INTEGER, height INTEGER, alpha INTEGER,
  bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- previous images (the last few are kept when an image is replaced)
CREATE TABLE IF NOT EXISTS image_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sprite_id TEXT NOT NULL REFERENCES sprites(id) ON DELETE CASCADE,
  data BLOB NOT NULL, format TEXT NOT NULL, width INTEGER, height INTEGER, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  uploaded_at TEXT NOT NULL, replaced_at TEXT NOT NULL
);

-- append-only change log for plugins that poll (no foreign key: events outlive deleted sprites)
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, sprite_id TEXT NOT NULL,
  format TEXT, width INTEGER, height INTEGER, bytes INTEGER, sha256 TEXT, targets TEXT NOT NULL DEFAULT '[]'
);
`;

/** @param {string} file path of the database file, or ':memory:' */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a transaction; any thrown error rolls everything back and is re-thrown. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
