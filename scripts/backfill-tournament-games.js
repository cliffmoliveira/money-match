/**
 * One-shot backfill: populate tournament_games for all upcoming tournaments
 * already in the DB that are missing game associations.
 *
 * Usage:  node scripts/backfill-tournament-games.js [--dry-run]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/db');
const { startgg } = require('../startggClient');
const { applyFuturesMetaSchema, upsertTournamentGame, upsertEntrantCount } = require('../futuresMeta');

const GAME_IDS = require('./sync-upcoming').GAME_IDS;
const GAME_ID_SET = new Set(GAME_IDS);

const REQUEST_GAP_MS = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables) {
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await startgg(query, variables);
      await sleep(REQUEST_GAP_MS);
      return data;
    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || (!err.response && !!err.request);
      if (!retryable || attempt >= 5) throw err;
      const backoff = Math.min(60000, 2000 * 2 ** attempt);
      console.warn(`  start.gg ${status || 'network'}; retry in ${backoff / 1000}s`);
      await sleep(backoff);
    }
  }
}

const EVENTS_QUERY = `
query TournamentEvents($id: ID!) {
  tournament(id: $id) {
    events(limit: 30) {
      id name numEntrants
      videogame { id name }
    }
  }
}`;

async function upsertGame(g) {
  const existing = await db.getAsync('SELECT id FROM games WHERE startgg_id = ? OR name = ?', [g.id, g.name]);
  if (existing) {
    await db.runAsync('UPDATE games SET startgg_id = COALESCE(startgg_id, ?) WHERE id = ?', [g.id, existing.id]);
    return existing.id;
  }
  const result = await db.runAsync('INSERT INTO games (name, startgg_id) VALUES (?, ?)', [g.name, g.id]);
  return result.lastID;
}

async function run(dryRun) {
  await applyFuturesMetaSchema();

  // All upcoming tournaments already in DB that have a startgg_id.
  const upcoming = await db.allAsync(
    `SELECT id, name, startgg_id FROM tournaments
     WHERE startgg_id IS NOT NULL
       AND date(date) >= date('now', '-1 day')
     ORDER BY date(date) ASC`
  );
  console.log(`[backfill-tournament-games] ${upcoming.length} upcoming tournament(s) to check`);

  let added = 0;
  for (const t of upcoming) {
    let data;
    try {
      data = await gql(EVENTS_QUERY, { id: t.startgg_id });
    } catch (err) {
      console.error(`  ${t.name}: API error — ${err.message}`);
      continue;
    }

    const events = (data?.tournament?.events || [])
      .filter((ev) => ev.videogame && GAME_ID_SET.has(Number(ev.videogame.id)));

    if (events.length === 0) continue;

    const gameNames = events.map((ev) => ev.videogame.name);
    console.log(`  ${t.name}: ${gameNames.join(', ')}`);

    if (!dryRun) {
      for (const ev of events) {
        const gameId = await upsertGame(ev.videogame);
        await upsertTournamentGame(t.id, gameId);
        if (ev.numEntrants) await upsertEntrantCount(t.id, gameId, ev.numEntrants);
      }
      added += events.length;
    }
  }

  console.log(`[backfill-tournament-games] done${dryRun ? ' (dry run)' : ''}: ${added} game links added`);
}

const dryRun = process.argv.includes('--dry-run');
run(dryRun).then(() => process.exit(0)).catch((err) => {
  console.error(`\nStopped: ${err.message}`);
  process.exit(1);
});
