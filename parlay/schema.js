// Futures parlay schema. Idempotent + additive — a parlay is one ticket whose
// stake rides across several outright-winner legs; it pays only if every leg wins.
async function applyParlaySchema(db) {
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS parlays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      stake_cents INTEGER NOT NULL,
      combined_odds REAL NOT NULL,
      payout_cents INTEGER,
      status TEXT NOT NULL DEFAULT 'open',   -- open | won | lost | void
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      settled_at TEXT
    )`);
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS parlay_legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parlay_id INTEGER NOT NULL,
      tournament_id INTEGER NOT NULL,
      game_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      leg_odds REAL NOT NULL,
      result TEXT NOT NULL DEFAULT 'pending',  -- pending | won | lost | void
      FOREIGN KEY (parlay_id) REFERENCES parlays(id)
    )`);
  await db.runAsync('CREATE INDEX IF NOT EXISTS idx_parlay_legs_parlay ON parlay_legs(parlay_id)');
  await db.runAsync('CREATE INDEX IF NOT EXISTS idx_parlay_legs_market ON parlay_legs(tournament_id, game_id)');
}

module.exports = { applyParlaySchema };
