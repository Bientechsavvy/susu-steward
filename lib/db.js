// SQLite ledger using Node's built-in node:sqlite (Node 22.13+). Zero npm dependencies.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const cfg = require('./env');

const db = new DatabaseSync(cfg.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS circles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
  cadence TEXT NOT NULL, start_date TEXT NOT NULL, n_members INTEGER NOT NULL,
  status TEXT NOT NULL, current_round INTEGER NOT NULL DEFAULT 0, owner_member_id TEXT NOT NULL,
  sim_offset_days INTEGER NOT NULL DEFAULT 0, auto_send INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
  position INTEGER NOT NULL, token TEXT NOT NULL, email_changed_at TEXT, joined_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, number INTEGER NOT NULL, due_date TEXT NOT NULL,
  recipient_member_id TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, round_id TEXT NOT NULL, member_id TEXT NOT NULL,
  order_id TEXT, capture_id TEXT UNIQUE NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY, circle_id TEXT NOT NULL, round_id TEXT NOT NULL, recipient_member_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, status TEXT NOT NULL, risk_level TEXT, risk_json TEXT,
  batch_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id TEXT, ts TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, type TEXT, received_at TEXT);
`);

const uid = () => crypto.randomBytes(5).toString('hex');
const token = () => crypto.randomBytes(16).toString('hex');
const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

module.exports = { db, uid, token, all, get, run };
