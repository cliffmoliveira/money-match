/**
 * Idempotent schema migration for the affiliate attribution loop.
 * Creates click_records, postback_log, conversion_records.
 * Usage:
 *   node scripts/migrate-affiliate.js
 *   DATABASE_PATH=./db/test.db node scripts/migrate-affiliate.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');

async function migrate() {
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS click_records (
      click_id      TEXT PRIMARY KEY,
      user_id       INTEGER,
      region        TEXT,
      book          TEXT,
      affiliate_id  TEXT,
      event_id TEXT, match_id TEXT, market_id TEXT, selection_id TEXT, participant_id TEXT,
      source_page   TEXT,
      deep_link_url TEXT,
      status        TEXT NOT NULL DEFAULT 'clicked',
      created_at    TEXT NOT NULL
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_click_book ON click_records(book)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_click_status ON click_records(status)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_click_created ON click_records(created_at)`);
  console.log('click_records ready');

  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS postback_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at     TEXT NOT NULL,
      remote_ip       TEXT,
      signature_valid INTEGER,
      book TEXT, external_ref TEXT, click_id TEXT,
      outcome         TEXT,
      raw_payload     TEXT NOT NULL
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_plog_received ON postback_log(received_at)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_plog_click ON postback_log(click_id)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_plog_ref ON postback_log(book, external_ref)`);
  console.log('postback_log ready');

  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS conversion_records (
      conversion_id     TEXT PRIMARY KEY,
      postback_log_id   INTEGER,
      click_id          TEXT,
      book TEXT, external_ref TEXT,
      conversion_type   TEXT,
      amount            INTEGER,
      currency          TEXT NOT NULL,
      commission_model  TEXT,
      commission_value  INTEGER,
      validation_status TEXT NOT NULL DEFAULT 'pending',
      received_at TEXT,
      resolved_at TEXT,
      UNIQUE (book, external_ref),
      FOREIGN KEY (postback_log_id) REFERENCES postback_log (id),
      FOREIGN KEY (click_id) REFERENCES click_records (click_id)
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_conv_click ON conversion_records(click_id)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_conv_status ON conversion_records(validation_status)`);
  console.log('conversion_records ready');

  console.log('Affiliate migration complete.');
}

migrate().then(() => process.exit(0)).catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
