/**
 * Idempotent schema migration for pick'em & scoring (spec §2).
 * Extends set_markets + users and adds pickem_picks, coin_ledger,
 * leaderboard_entries, seasons. Run after migrate-live-betting.js (needs
 * set_markets/users to exist).
 *
 *   DATABASE_PATH=./db/database.db node scripts/migrate-pickem.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');
const { applyPickemSchema } = require('../pickem/schema');

applyPickemSchema(db)
  .then(() => { console.log("Pick'em schema migration complete."); process.exit(0); })
  .catch((err) => { console.error("Pick'em migration failed:", err.message); process.exit(1); });
