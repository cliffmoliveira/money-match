// Per-(tournament, game) futures metadata that doesn't belong on the per-entrant
// players_games_tournaments rows. Currently just the start.gg entrant count for
// each event, shown on the Future Tournaments page. Idempotent schema so it can
// be ensured at server startup and by the sync/backfill scripts.
const db = require('./db/db');

async function applyFuturesMetaSchema() {
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS tournament_games (
      tournament_id INTEGER NOT NULL,
      game_id       INTEGER NOT NULL,
      num_entrants  INTEGER,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tournament_id, game_id),
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);
}

// Upsert the entrant count for one event. Null/undefined counts are ignored so a
// missing start.gg value never clobbers a previously-recorded number.
async function upsertEntrantCount(tournamentId, gameId, numEntrants) {
  if (numEntrants == null) return;
  await db.runAsync(
    `INSERT INTO tournament_games (tournament_id, game_id, num_entrants, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(tournament_id, game_id) DO UPDATE
       SET num_entrants = excluded.num_entrants, updated_at = CURRENT_TIMESTAMP`,
    [tournamentId, gameId, numEntrants]
  );
}

module.exports = { applyFuturesMetaSchema, upsertEntrantCount };
