const path = require('path');
const fs = require('fs');
const os = require('os');

// Point db/db.js at a fresh temp SQLite file, create the affiliate tables, and
// return the db handle. Call once per test FILE (in `before`). repo.js caches
// its db handle at load, so do NOT call this per-test; use resetTables instead.
async function freshDb() {
  const file = path.join(os.tmpdir(), `mm-affiliate-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  const db = require('../../db/db');
  await db.runAsync(`CREATE TABLE IF NOT EXISTS click_records (
    click_id TEXT PRIMARY KEY, user_id INTEGER, region TEXT, book TEXT, affiliate_id TEXT,
    event_id TEXT, match_id TEXT, market_id TEXT, selection_id TEXT, participant_id TEXT,
    source_page TEXT, deep_link_url TEXT, status TEXT NOT NULL DEFAULT 'clicked', created_at TEXT NOT NULL)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS postback_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL, remote_ip TEXT,
    signature_valid INTEGER, book TEXT, external_ref TEXT, click_id TEXT, outcome TEXT, raw_payload TEXT NOT NULL)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS conversion_records (
    conversion_id TEXT PRIMARY KEY, postback_log_id INTEGER, click_id TEXT, book TEXT, external_ref TEXT,
    conversion_type TEXT, amount INTEGER, currency TEXT NOT NULL, commission_model TEXT, commission_value INTEGER,
    validation_status TEXT NOT NULL DEFAULT 'pending', received_at TEXT, resolved_at TEXT,
    UNIQUE (book, external_ref))`);
  return { db, file };
}

function cleanup(file) { try { fs.unlinkSync(file); } catch { /* ignore */ } }

// Clear the three tables between tests that assert exact counts.
async function resetTables(db) {
  await db.runAsync('DELETE FROM conversion_records');
  await db.runAsync('DELETE FROM postback_log');
  await db.runAsync('DELETE FROM click_records');
}

const express = require('express');
function makeApp() {
  const app = express();
  app.use('/api/affiliate', require('../../affiliate/router'));
  return app;
}

module.exports = { freshDb, cleanup, resetTables, makeApp };
