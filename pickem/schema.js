// Pick'em schema (spec §2). Idempotent and additive: extends the EXISTING
// `set_markets` (= markets) and `users` tables, and adds the pick'em-only tables.
// Reuses set_markets.winner_id as the "winning selection" and the inline
// player1_id/player2_id as the two selections — no parallel markets/selections.

async function columnExists(db, table, column) {
  const cols = await db.allAsync(`PRAGMA table_info(${table})`);
  return cols.some((c) => c.name === column);
}

async function addColumn(db, table, column, type) {
  if (!(await columnExists(db, table, column))) {
    await db.runAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

async function applyPickemSchema(db) {
  // Extend markets (set_markets) with pick'em fields.
  await addColumn(db, 'set_markets', 'round', 'TEXT');                 // r1|r2|r3|top8|top4|gf
  await addColumn(db, 'set_markets', 'round_multiplier', 'REAL');      // resolved at lock
  await addColumn(db, 'set_markets', 'locks_at', 'TEXT');              // picks freeze here (ISO)
  await addColumn(db, 'set_markets', 'community_split', 'TEXT');       // JSON {player_id: share} at lock
  await addColumn(db, 'set_markets', 'pickem_scored_at', 'TEXT');      // idempotent settle guard

  // Coins are a distinct no-cash reward currency, separate from the betting
  // wallet (users.balance_cents). Never sourced from real money.
  await addColumn(db, 'users', 'coin_balance', 'INTEGER NOT NULL DEFAULT 0');

  // Free winner picks — kept separate from the money table set_bets.
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS pickem_picks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL,
      market_id        INTEGER NOT NULL,
      picked_player_id INTEGER NOT NULL,
      result           TEXT NOT NULL DEFAULT 'pending',  -- pending|correct|incorrect|void
      points_awarded   INTEGER NOT NULL DEFAULT 0,
      coins_awarded    INTEGER NOT NULL DEFAULT 0,
      scored_at        TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, market_id)
    )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_pickem_picks_market ON pickem_picks(market_id)`);

  // Auditable coin ledger. users.coin_balance = running SUM(delta).
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS coin_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      delta       INTEGER NOT NULL,   -- + earned; never from real money
      reason      TEXT NOT NULL,      -- pick_reward|streak_bonus|daily_login|seasonal_reset
      ref_pick_id INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_coin_ledger_user ON coin_ledger(user_id)`);

  // Materialized leaderboard aggregates. scope_ref is '' for global (avoids the
  // SQLite "NULL in PRIMARY KEY isn't unique" pitfall).
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS leaderboard_entries (
      user_id        INTEGER NOT NULL,
      scope          TEXT NOT NULL,    -- global|game|event|season
      scope_ref      TEXT NOT NULL DEFAULT '',  -- '' for global; game/event/season id otherwise
      points         INTEGER NOT NULL DEFAULT 0,
      correct_count  INTEGER NOT NULL DEFAULT 0,
      total_picks    INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      best_streak    INTEGER NOT NULL DEFAULT 0,
      updated_at     TEXT,
      PRIMARY KEY (user_id, scope, scope_ref)
    )`);

  // Seasons (soft reset on the FGC circuit calendar).
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS seasons (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      name      TEXT,
      circuit   TEXT,   -- cpt|twt|mixed
      starts_at TEXT,
      ends_at   TEXT
    )`);
}

module.exports = { applyPickemSchema, columnExists };
