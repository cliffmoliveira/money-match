/**
 * Idempotent schema migration for password reset.
 * Usage:
 *   node scripts/migrate-password-reset.js
 *   DATABASE_PATH=./db/test.db node scripts/migrate-password-reset.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');

async function migrate() {
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      token_hash  TEXT NOT NULL,            -- sha256 of the raw token (link carries the raw token)
      expires_at  TEXT NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_prt_token ON password_reset_tokens(token_hash)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id)`);
  console.log('password_reset_tokens ready');
}

migrate().then(() => process.exit(0)).catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
