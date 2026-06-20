/**
 * Idempotent migration for the account/profile fields: adds optional profile
 * columns to users and backfills display_name from username.
 *
 *   DATABASE_PATH=./db/database.db node scripts/migrate-account.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');
const { applyAccountSchema } = require('../account');

applyAccountSchema(db)
  .then(() => { console.log('Account schema migration complete.'); process.exit(0); })
  .catch((err) => { console.error('Account migration failed:', err.message); process.exit(1); });
