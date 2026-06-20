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

// display name, full name, country, favorite game, main, gender,
// [points, correct, total, currentStreak, bestStreak], balance (FM dollars)
const ROSTER = [
  ['WBG | MenaRD',    'Saul Leonardo Mena II', 'Dominican Republic', 'Street Fighter 6',     'Blanka',     'Male',   [6240, 38, 47,  9, 14], 4820],
  ['FLY | Punk',      'Victor Woodley',        'United States',      'Street Fighter 6',     'Cammy',      'Male',   [5810, 41, 55,  4, 11], 3110],
  ['Tokido',          'Hajime Taniguchi',      'Japan',              'Street Fighter 6',     'Ken',        'Male',   [5430, 33, 42, 12, 12], 6010],
  ['FALCONS | Daigo', 'Daigo Umehara',         'Japan',              'Street Fighter 6',     'Guile',      'Male',   [4990, 35, 49,  0,  9], 2240],
  ['Arslan Ash',      'Arslan Siddique',       'Pakistan',           'TEKKEN 8',             'Azucena',    'Male',   [4720, 29, 36,  7, 13], 5290],
  ['ROX | Knee',      'Bae Jae-min',           'South Korea',        'TEKKEN 8',             'Bryan',      'Male',   [4380, 31, 45,  3,  8], 1880],
  ['iDom',            'Derek Ruffin',          'United States',      'Street Fighter 6',     'Manon',      'Male',   [3910, 27, 40,  5, 10], 4470],
  ['Kakeru',          'Kakeru Suzuki',         'Japan',              'Guilty Gear: Strive',  'Ramlethal',  'Male',   [3540, 24, 33,  2,  7], 900],
  ['Chocoblanka',     'Ai Sakura',             'Japan',              'Street Fighter 6',     'Chun-Li',    'Female', [3120, 26, 41,  6,  9], 3360],
  ['NuckleDu',        'Du Dang',               'United States',      'Street Fighter 6',     'Rashid',     'Male',   [2780, 21, 35,  0,  6], 2050],
  ['DFM | Gachikun',  'Goichi Kishida',        'Japan',              'Street Fighter 6',     'Rashid',     'Male',   [2310, 19, 31,  4,  8], 1290],
  ['Bonchan',         'Masato Takahashi',      'Japan',              'Street Fighter 6',     'Luke',       'Male',   [1870, 17, 29,  1,  5], 770],
];

const handle = (dn) => dn.replace(/[^a-z0-9]/gi, '').toLowerCase();

async function seed() {
  await applyPickemSchema(db);
  await applyAccountSchema(db);

  let id = 9001;
  for (const [dn, full, country, game, main, gender, [points, correct, total, cur, best], fm] of ROSTER) {
    const h = handle(dn);
    await db.runAsync(
      `INSERT OR REPLACE INTO users
         (id, username, email, password, display_name, full_name, country,
          favorite_game, main_character, gender, balance_cents, coin_balance)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, h, `${h}@demo.local`, 'demo-no-login', dn, full, country, game, main, gender, fm * 100, Math.round(points * 0.5)]
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
