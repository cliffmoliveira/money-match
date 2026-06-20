/**
 * Idempotent schema migration for the Fight Money economy: adds the daily-bonus
 * bookkeeping columns (last_daily_bonus_at, daily_streak) to users.
 *
 *   DATABASE_PATH=./db/database.db node scripts/migrate-economy.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');
const { applyEconomySchema } = require('../economy');

applyEconomySchema(db)
  .then(() => { console.log('Economy schema migration complete.'); process.exit(0); })
  .catch((err) => { console.error('Economy migration failed:', err.message); process.exit(1); });
