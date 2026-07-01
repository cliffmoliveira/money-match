/**
 * Seed demo players (FGC-flavored profiles + pick'em leaderboard standings) so
 * the Ranks page has data to test against. Idempotent: demo users live in the
 * id >= 9001 / "@demo.local" range and are replaced on re-run.
 *
 *   DATABASE_PATH=./db/database.db node scripts/seed-ranks-demo.js
 *
 * To remove them later:
 *   DELETE FROM leaderboard_entries WHERE user_id >= 9001;
 *   DELETE FROM users WHERE id >= 9001;
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');
const { applyPickemSchema } = require('../pickem/schema');
const { applyAccountSchema } = require('../account');
const { beamAvatarDataUrl } = require('./lib/beam-avatar');

// These are SITE USERS (fans/bettors), not the pros who play the matches — so the
// names are gamertags; favorite_game/main reflect what the *fan* likes.
// gamertag, full name, country, favorite game, main, gender,
// [points, correct, total, currentStreak, bestStreak]
// FM balance is randomized at seed time (the Ranks leaderboard sorts by FM,
// not points), so it's regenerated on every re-run instead of hand-authored.
const ROSTER = [
  ['ParryKing',      'Marcus Hale',    'United States',  'Street Fighter 6',    'Ken',        'Male',   [6240, 38, 47,  9, 14]],
  ['okizeme_andy',   'Andre Pruitt',   'United States',  'TEKKEN 8',            'Jin',        'Male',   [5810, 41, 55,  4, 11]],
  ['ComboQueen',     'Renee Vasquez',  'United States',  'Guilty Gear: Strive', 'Millia',     'Female', [5430, 33, 42, 12, 12]],
  ['frame_trap_kel', "Kelly O'Brien",  'Ireland',        'Street Fighter 6',    'Dhalsim',    'Female', [4990, 35, 49,  0,  9]],
  ['WakeupDP',       'Devon Park',     'Canada',         'Street Fighter 6',    'Ryu',        'Male',   [4720, 29, 36,  7, 13]],
  ['NeutralSkipper', 'Sam Idris',      'United Kingdom', 'TEKKEN 8',            'King',       'Male',   [4380, 31, 45,  3,  8]],
  ['saltmine_sven',  'Sven Larsson',   'Sweden',         'Guilty Gear: Strive', 'Sol',        'Male',   [3910, 27, 40,  5, 10]],
  ['HitConfirmHana', 'Hana Kim',       'South Korea',    'Street Fighter 6',    'Juri',       'Female', [3540, 24, 33,  2,  7]],
  ['TechThrowTy',    'Tyrese Bell',    'United States',  'TEKKEN 8',            'Bryan',      'Male',   [3120, 26, 41,  6,  9]],
  ['ZonerSupreme',   'Diego Ramos',    'Mexico',         'Street Fighter 6',    'Guile',      'Male',   [2780, 21, 35,  0,  6]],
  ['MashGod99',      'Liam Nguyen',    'Australia',      'Street Fighter 6',    'Blanka',     'Male',   [2310, 19, 31,  4,  8]],
  ['TheLabMonster',  'Yuki Tanaka',    'Japan',          'Guilty Gear: Strive', 'Nagoriyuki', 'Other',  [1870, 17, 29,  1,  5]],
];

const handle = (dn) => dn.replace(/[^a-z0-9]/gi, '').toLowerCase();
// Random FM balance for a demo user, rounded to the nearest 10 FM. Range
// (500-8000 FM) mirrors the spread the old hand-authored values covered.
const randomFm = () => Math.round((500 + Math.random() * 7500) / 10) * 10;

async function seed() {
  await applyPickemSchema(db);
  await applyAccountSchema(db);

  let id = 9001;
  for (const [dn, full, country, game, main, gender, [points, correct, total, cur, best]] of ROSTER) {
    const h = handle(dn);
    const fm = randomFm();
    await db.runAsync(
      `INSERT OR REPLACE INTO users
         (id, username, email, password, display_name, full_name, country,
          favorite_game, main_character, gender, balance_cents, coin_balance, avatar)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, h, `${h}@demo.local`, 'demo-no-login', dn, full, country, game, main, gender, fm * 100, Math.round(points * 0.5), beamAvatarDataUrl(dn)]
    );
    await db.runAsync(
      `INSERT OR REPLACE INTO leaderboard_entries
         (user_id, scope, scope_ref, points, correct_count, total_picks, current_streak, best_streak, updated_at)
       VALUES (?, 'global', '', ?, ?, ?, ?, ?, datetime('now'))`,
      [id, points, correct, total, cur, best]
    );
    id += 1;
  }
  console.log(`Seeded ${ROSTER.length} demo players (ids 9001-${id - 1}) into users + leaderboard_entries.`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Ranks demo seed failed:', err.message); process.exit(1); });
