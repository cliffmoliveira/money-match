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
  await db.runAsync(`CREATE TABLE tournaments (id INTEGER PRIMARY KEY, name TEXT, date TEXT, startgg_id TEXT, is_live INTEGER DEFAULT 0)`);
  await db.runAsync(`CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT)`);
  await db.runAsync(`CREATE TABLE players_games_tournaments (tournament_id INTEGER, game_id INTEGER, player_id INTEGER, seed_num INTEGER)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM players_games_tournaments');
  await db.runAsync('DELETE FROM games');
  await db.runAsync('DELETE FROM tournaments');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

async function addTournament(id, name, date, { isLive = 0 } = {}) {
  await db.runAsync('INSERT INTO tournaments (id, name, date, startgg_id, is_live) VALUES (?,?,?,?,?)',
    [id, name, date, `sgg-${id}`, isLive]);
}
async function addGame(id, name) { await db.runAsync('INSERT INTO games (id, name) VALUES (?,?)', [id, name]); }
async function trackGame(tournamentId, gameId) {
  await db.runAsync('INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, seed_num) VALUES (?,?,?,1)',
    [tournamentId, gameId, 1]);
}

test('returns the soonest upcoming tournament that has tracked games', async () => {
  await addGame(10, 'Street Fighter 6');
  await addGame(11, 'TEKKEN 8');
  await addTournament(1, 'Later Major', '2099-12-31');
  await trackGame(1, 10);
  await addTournament(2, 'Sooner Major', '2099-01-01');
  await trackGame(2, 10);
  await trackGame(2, 11);

  const { tournament, games } = await lm.getUpcoming();
  assert.equal(tournament.id, 2);
  assert.equal(tournament.name, 'Sooner Major');
  assert.deepEqual(games.map((g) => g.name), ['Street Fighter 6', 'TEKKEN 8']);
});

test('skips a sooner tournament that has no tracked games', async () => {
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'No Games Major', '2099-01-01'); // no trackGame
  await addTournament(2, 'Has Games Major', '2099-06-01');
  await trackGame(2, 10);

  const { tournament } = await lm.getUpcoming();
  assert.equal(tournament.id, 2);
});

test('prefers a live tournament over a future-dated one', async () => {
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'Future Major', '2099-01-01');
  await trackGame(1, 10);
  await addTournament(2, 'Live Now Major', '2000-01-01', { isLive: 1 }); // past date but flagged live
  await trackGame(2, 10);

  const { tournament } = await lm.getUpcoming();
  assert.equal(tournament.id, 2);
});

test('returns null tournament when nothing is upcoming or live', async () => {
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'Old Major', '2000-01-01'); // finished, not live
  await trackGame(1, 10);

  const result = await lm.getUpcoming();
  assert.equal(result.tournament, null);
  assert.deepEqual(result.games, []);
});
