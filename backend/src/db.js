import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export function initDB(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Schéma minimal
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      stage TEXT,
      amount REAL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS factures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT UNIQUE,
      data TEXT NOT NULL,
      total_ttc REAL,
      status TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      siret TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS bridge_users (
      external_user_id TEXT PRIMARY KEY,
      bridge_uuid TEXT,
      access_token TEXT,
      token_expires_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_user_id TEXT,
      bridge_id TEXT UNIQUE,
      date TEXT,
      label TEXT,
      amount REAL,
      currency TEXT DEFAULT 'EUR',
      matched_facture_id INTEGER,
      raw TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS rag_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      source TEXT,
      content TEXT,
      embedding TEXT,
      tokens INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot TEXT,
      subject TEXT,
      body TEXT,
      sent_to TEXT,
      sent_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS improvement_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT UNIQUE,
      title TEXT,
      category TEXT,
      rationale TEXT,
      impact TEXT,
      effort TEXT,
      implementation TEXT,
      status TEXT DEFAULT 'pending',
      decided_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS media_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT,                  -- 'image' | 'video'
      file_name TEXT,             -- nom local sous MEDIA_DIR
      operation_name TEXT,        -- pour les vidéos Veo (LRO)
      mime TEXT,
      prompt TEXT,
      ratio TEXT,
      duration INTEGER,
      status TEXT DEFAULT 'ready',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);

  return db;
}
