/**
 * Idempotent schema migration for the live per-set betting feature.
 *
 * Runs against the real DB via db/db.js (honors DATABASE_PATH). Safe to run
 * repeatedly: it checks for existing columns/tables before creating them and
 * only grants a starting balance to users who have never been granted one.
 *
 * Usage:
 *   node scripts/migrate-live-betting.js
 *   DATABASE_PATH=./db/database.test.db node scripts/migrate-live-betting.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');

const STARTING_GRANT_CENTS = 100000; // $1000 virtual-currency

async function columnExists(table, column) {
  const cols = await db.allAsync(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

async function migrate() {
  // --- Phase 1: wallet ---
  if (!(await columnExists('users', 'balance_cents'))) {
    await db.runAsync(`ALTER TABLE users ADD COLUMN balance_cents INTEGER NOT NULL DEFAULT 0`);
    console.log('users.balance_cents added');
  } else {
    console.log('users.balance_cents already present');
  }

  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,         -- signed: credit > 0, debit < 0
      type TEXT NOT NULL,                    -- grant|bet_stake|bet_payout|refund (later deposit|withdrawal)
      ref_type TEXT,                         -- e.g. 'set_bet'
      ref_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_transactions(user_id)`);
  console.log('wallet_transactions ready');

  // One-time starting grant for users who have never received one.
  const ungranted = await db.allAsync(`
    SELECT u.id FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM wallet_transactions w WHERE w.user_id = u.id AND w.type = 'grant'
    )
  `);
  for (const { id } of ungranted) {
    await db.runAsync(`UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?`, [STARTING_GRANT_CENTS, id]);
    await db.runAsync(
      `INSERT INTO wallet_transactions (user_id, amount_cents, type) VALUES (?, ?, 'grant')`,
      [id, STARTING_GRANT_CENTS]
    );
  }
  console.log(`granted starting balance to ${ungranted.length} user(s)`);

  // --- Phase 2: live set markets + bets ---
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS set_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      game_id INTEGER NOT NULL,
      startgg_set_id TEXT UNIQUE,
      round_text TEXT,
      player1_id INTEGER NOT NULL,
      player2_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',     -- open|closed|settled|void
      p1_prob REAL NOT NULL,
      p2_prob REAL NOT NULL,
      seed_k_cents INTEGER NOT NULL,
      p1_pool_cents INTEGER NOT NULL DEFAULT 0,
      p2_pool_cents INTEGER NOT NULL DEFAULT 0,
      p1_live_odds REAL NOT NULL,
      p2_live_odds REAL NOT NULL,
      winner_id INTEGER,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      settled_at TEXT,
      FOREIGN KEY (tournament_id) REFERENCES tournaments (id),
      FOREIGN KEY (game_id) REFERENCES games (id)
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_set_markets_state ON set_markets(state)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_set_markets_tg ON set_markets(tournament_id, game_id)`);
  console.log('set_markets ready');

  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS set_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      market_id INTEGER NOT NULL,
      picked_player_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      locked_odds REAL NOT NULL,
      state TEXT NOT NULL DEFAULT 'placed',   -- placed|won|lost|refunded
      payout_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (market_id) REFERENCES set_markets (id)
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_set_bets_user ON set_bets(user_id)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_set_bets_market ON set_bets(market_id)`);
  // Speeds up the house-bankroll aggregate (SUM over WHERE state IN ('won','lost')),
  // which is the scan recomputeOdds/settle would otherwise run against the full ledger.
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_set_bets_state ON set_bets(state)`);
  console.log('set_bets ready');

  // Manual "this tournament is live" flag for poller control during an event.
  if (!(await columnExists('tournaments', 'is_live'))) {
    await db.runAsync(`ALTER TABLE tournaments ADD COLUMN is_live INTEGER NOT NULL DEFAULT 0`);
    console.log('tournaments.is_live added');
  } else {
    console.log('tournaments.is_live already present');
  }

  // --- Bracket view: position + scores on each market ---
  const bracketCols = [
    ['set_markets', 'round_int', 'INTEGER'],          // Start.gg round: >0 winners, <0 losers
    ['set_markets', 'phase_group_id', 'TEXT'],        // Top 8 bracket grouping
    ['set_markets', 'p1_score', 'INTEGER NOT NULL DEFAULT 0'],
    ['set_markets', 'p2_score', 'INTEGER NOT NULL DEFAULT 0'],
    // Per-slot seed so odds can be computed once both entrants are in. A slot
    // with player id 0 is TBD (waiting on a feeder set); such a market is
    // 'pending' and not bettable until both slots are real.
    ['set_markets', 'p1_seed', 'INTEGER'],
    ['set_markets', 'p2_seed', 'INTEGER'],
    // Futures: seed shown on the Future Tournaments page (NULL for the "Field"
    // row). win_probability (already present) holds the seed-based fair prob.
    ['players_games_tournaments', 'seed_num', 'INTEGER'],
  ];
  for (const [table, col, type] of bracketCols) {
    if (!(await columnExists(table, col))) {
      await db.runAsync(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      console.log(`${table}.${col} added`);
    } else {
      console.log(`${table}.${col} already present`);
    }
  }

  console.log('Migration complete.');
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });

module.exports = { STARTING_GRANT_CENTS };
