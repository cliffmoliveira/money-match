const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// getUpcoming reads module-level db handle, so wire a fresh temp DB and require
// the module AFTER setting DATABASE_PATH (mirrors test/affiliate/helpers.js).
let db, lm, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-upcoming-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  delete require.cache[require.resolve('../../liveMarkets')];
  db = require('../../db/db');
  lm = require('../../liveMarkets');
  await db.runAsync(`CREATE TABLE tournaments (id INTEGER PRIMARY KEY, name TEXT, date TEXT, startgg_id TEXT, is_live INTEGER DEFAULT 0, logo_url TEXT, city TEXT, country TEXT)`);
  await db.runAsync(`CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT)`);
  await db.runAsync(`CREATE TABLE players_games_tournaments (tournament_id INTEGER, game_id INTEGER, player_id INTEGER, seed_num INTEGER)`);
  await db.runAsync(`CREATE TABLE tournament_games (tournament_id INTEGER, game_id INTEGER, num_entrants INTEGER)`);
  await db.runAsync(`CREATE TABLE set_markets (tournament_id INTEGER, state TEXT)`);
  // bracket_history is already created by db.js itself at require-time (see
  // its own CREATE TABLE IF NOT EXISTS) - don't recreate it here.
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM players_games_tournaments');
  await db.runAsync('DELETE FROM tournament_games');
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync('DELETE FROM bracket_history');
  await db.runAsync('DELETE FROM games');
  await db.runAsync('DELETE FROM tournaments');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

async function addTournament(id, name, date, { isLive = 0, startggId = `sgg-${id}` } = {}) {
  await db.runAsync('INSERT INTO tournaments (id, name, date, startgg_id, is_live) VALUES (?,?,?,?,?)',
    [id, name, date, startggId, isLive]);
}
async function addGame(id, name) { await db.runAsync('INSERT INTO games (id, name) VALUES (?,?)', [id, name]); }
async function trackGame(tournamentId, gameId) {
  await db.runAsync('INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, seed_num) VALUES (?,?,?,1)',
    [tournamentId, gameId, 1]);
}
async function addBracketHistory(tournamentId, gameId, setId) {
  await db.runAsync(
    `INSERT INTO bracket_history (tournament_id, game_id, startgg_set_id, state) VALUES (?,?,?,'completed')`,
    [tournamentId, gameId, setId]
  );
}

// getUpcoming() moved from "the single soonest tournament" to "every
// currently-relevant tournament" (commit 1b4253f, "show all seeded upcoming
// tournaments, not just next one") — it now returns an ARRAY of
// { tournament, games } pairs, furthest-out first. These tests used to
// destructure a single { tournament, games } object straight off the
// promise, which the array shape can never satisfy (Array has no .tournament
// property) — every assertion here silently failed on "no such table"
// errors from missing test fixtures first, masking that the tests
// themselves were also stale. Rewritten against the real, current contract;
// see client/src/components/Home.js's matching fix — its own consumer of
// this same endpoint had the identical stale single-object assumption.

test('returns every currently-relevant tournament with its tracked games, furthest-out first', async () => {
  await addGame(10, 'Street Fighter 6');
  await addGame(11, 'TEKKEN 8');
  await addTournament(1, 'Later Major', '2099-12-31');
  await trackGame(1, 10);
  await addTournament(2, 'Sooner Major', '2099-01-01');
  await trackGame(2, 10);
  await trackGame(2, 11);

  const result = await lm.getUpcoming();
  assert.equal(result.length, 2);
  assert.equal(result[0].tournament.id, 1, 'furthest-out (Later Major) sorts first');
  assert.equal(result[0].tournament.name, 'Later Major');
  assert.deepEqual(result[0].games.map((g) => g.name), ['Street Fighter 6']);
  assert.equal(result[1].tournament.id, 2);
  assert.deepEqual(result[1].games.map((g) => g.name), ['Street Fighter 6', 'TEKKEN 8']);
});

test('includes a tournament with no tracked games, with an empty games array rather than skipping it', async () => {
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'No Games Major', '2099-01-01'); // no trackGame
  await addTournament(2, 'Has Games Major', '2099-06-01');
  await trackGame(2, 10);

  const result = await lm.getUpcoming();
  assert.equal(result.length, 2);
  const noGames = result.find((r) => r.tournament.id === 1);
  assert.deepEqual(noGames.games, []);
});

test('includes a live tournament even with a past date, alongside a future-dated one', async () => {
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'Future Major', '2099-01-01');
  await trackGame(1, 10);
  await addTournament(2, 'Live Now Major', '2000-01-01', { isLive: 1 }); // past date but flagged live
  await trackGame(2, 10);
  await addTournament(3, 'Old Dead Major', '1999-01-01'); // past, not live, no markets - must not appear
  await trackGame(3, 10);

  const result = await lm.getUpcoming();
  const ids = result.map((r) => r.tournament.id).sort();
  assert.deepEqual(ids, [1, 2]);
  const live = result.find((r) => r.tournament.id === 2);
  assert.equal(live.tournament.isLive, 1);
});

test('includes a manually-ingested (startgg_id NULL) live tournament that has real bracket_history progress', async () => {
  // Mirrors ingest-manual-results.js's groupStages-only path: an EWC main-
  // stage event whose group stages are done but whose Finals Bracket hasn't
  // been played yet gets startgg_id=NULL, is_live=1, no set_markets at all -
  // it must still surface here (this is its only route into any listing;
  // getMarkets() requires >=1 set_markets row via its own JOIN, which a
  // groupStages-only event never has).
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'EWC Manual In Progress', '2026-07-29', { isLive: 1, startggId: null });
  await db.runAsync('INSERT INTO tournament_games (tournament_id, game_id, num_entrants) VALUES (1, 10, 32)');
  await addBracketHistory(1, 10, 'manual-x-gs-1');

  const result = await lm.getUpcoming();
  const ids = result.map((r) => r.tournament.id);
  assert.deepEqual(ids, [1]);
  assert.deepEqual(result[0].games.map((g) => g.name), ['Street Fighter 6']);
});

test('excludes a manually-ingested tournament with no bracket_history rows (an empty stub, not a real tracked event)', async () => {
  await addTournament(1, 'EWC Manual Empty Stub', '2026-07-29', { isLive: 1, startggId: null });

  const result = await lm.getUpcoming();
  assert.deepEqual(result, []);
});

test('includes a manually-tracked event seeded ahead of time (future date, no bracket_history yet)', async () => {
  // Mirrors auto-sync-manual-events.js's seedUpcomingTournament: a
  // not-yet-started EWC main-stage event gets a bare tournaments row
  // (startgg_id NULL, is_live 0, no bracket_history at all) well before any
  // set is played, purely off its real future date.
  await addGame(10, 'TEKKEN 8');
  await db.runAsync(
    "INSERT INTO tournaments (id, name, date, startgg_id, is_live) VALUES (1, 'EWC Manual Seeded', '2099-01-01', NULL, 0)"
  );
  await db.runAsync('INSERT INTO tournament_games (tournament_id, game_id, num_entrants) VALUES (1, 10, 32)');

  const result = await lm.getUpcoming();
  assert.deepEqual(result.map((r) => r.tournament.id), [1]);
  assert.deepEqual(result[0].games.map((g) => g.name), ['TEKKEN 8']);
});

test('returns an empty array when nothing is upcoming or live', async () => {
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'Old Major', '2000-01-01'); // finished, not live
  await trackGame(1, 10);

  const result = await lm.getUpcoming();
  assert.deepEqual(result, []);
});
