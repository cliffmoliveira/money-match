/**
 * One-shot backfill of start.gg entrant counts for tournaments already on the
 * Future Tournaments page. Lighter than a full sync: it only reads numEntrants
 * per event and upserts tournament_games — it never touches seeds, odds, or bets.
 *
 *   DATABASE_PATH=./db/database.db node scripts/backfill-entrant-counts.js
 *
 * (Going forward, the daily sync records the count automatically.)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/db');
const { startgg } = require('../startggClient');
const { applyFuturesMetaSchema, upsertEntrantCount } = require('../futuresMeta');
const { GAME_IDS } = require('./sync-upcoming');

const QUERY = `
query EntrantCounts($id: ID!, $ids: [ID]) {
  tournament(id: $id) {
    id name
    events(limit: 30, filter: { videogameId: $ids }) {
      id numEntrants videogame { id name }
    }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await applyFuturesMetaSchema();

  // Only tournaments that actually show game sections (have persisted entrants)
  // and have a start.gg id to look up.
  const tournaments = await db.allAsync(`
    SELECT DISTINCT t.id, t.startgg_id, t.name
    FROM tournaments t
    JOIN players_games_tournaments pgt ON pgt.tournament_id = t.id
    WHERE t.startgg_id IS NOT NULL AND t.date >= DATE('now')
    ORDER BY t.date ASC
  `);
  console.log(`Backfilling entrant counts for ${tournaments.length} upcoming tournament(s).`);

  let updated = 0;
  for (const t of tournaments) {
    try {
      const data = await startgg(QUERY, { id: String(t.startgg_id), ids: GAME_IDS });
      const events = data?.tournament?.events || [];
      for (const ev of events) {
        if (ev.numEntrants == null || !ev.videogame) continue;
        // Match by start.gg id, falling back to name — a game row may exist by
        // name with a NULL startgg_id (mirrors upsertGame's lookup in the sync).
        const g = await db.getAsync(
          'SELECT id FROM games WHERE startgg_id = ? OR name = ?',
          [Number(ev.videogame.id), ev.videogame.name]
        );
        if (!g) continue;
        // Only record counts for games actually present on this tournament's page.
        const present = await db.getAsync(
          'SELECT 1 FROM players_games_tournaments WHERE tournament_id = ? AND game_id = ? LIMIT 1',
          [t.id, g.id]
        );
        if (!present) continue;
        await upsertEntrantCount(t.id, g.id, ev.numEntrants);
        updated++;
        console.log(`  ${t.name} / ${ev.videogame.name}: ${ev.numEntrants}`);
      }
      await sleep(900); // be gentle with the start.gg rate limit
    } catch (err) {
      console.error(`  ${t.name} [${t.startgg_id}]: ${err.message}`);
    }
  }
  console.log(`Done. Updated ${updated} (tournament, game) entrant count(s).`);
}

run().then(() => process.exit(0)).catch((err) => { console.error(`Backfill failed: ${err.message}`); process.exit(1); });
