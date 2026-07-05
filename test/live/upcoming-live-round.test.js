const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// getUpcoming's hasLiveRound signal must reflect actual in-progress match
// activity in bracket_history, not just "the scheduled start time has
// passed" - a delayed/not-yet-started bracket shouldn't read as LIVE just
// because its start time came and went.
let db, lm, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-upcoming-live-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  delete require.cache[require.resolve('../../liveMarkets')];
  db = require('../../db/db');
  lm = require('../../liveMarkets');
  await db.runAsync(`CREATE TABLE tournaments (id INTEGER PRIMARY KEY, name TEXT, date TEXT, city TEXT, country TEXT, startgg_id TEXT, is_live INTEGER DEFAULT 0, logo_url TEXT)`);
  await db.runAsync(`CREATE TABLE tournament_games (tournament_id INTEGER, game_id INTEGER, num_entrants INTEGER)`);
  await db.runAsync(`CREATE TABLE players_games_tournaments (tournament_id INTEGER, game_id INTEGER, player_id INTEGER, seed_num INTEGER)`);
  await db.runAsync(`CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT)`);
  await db.runAsync(`CREATE TABLE set_markets (id INTEGER PRIMARY KEY, tournament_id INTEGER, state TEXT)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS bracket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER, startgg_set_id TEXT UNIQUE, round_text TEXT, round_int INTEGER, phase_order INTEGER, state TEXT, player1_id INTEGER, player2_id INTEGER, winner_id INTEGER, player1_score INTEGER, player2_score INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM tournaments');
  await db.runAsync('DELETE FROM tournament_games');
  await db.runAsync('DELETE FROM players_games_tournaments');
  await db.runAsync('DELETE FROM games');
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync('DELETE FROM bracket_history');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

async function addTournament(id, name, { isLive = 1 } = {}) {
  await db.runAsync('INSERT INTO tournaments (id, name, date, startgg_id, is_live) VALUES (?,?,?,?,?)',
    [id, name, '2026-07-05', `sgg-${id}`, isLive]);
}

test('hasLiveRound is true when bracket_history has an in-progress set', async () => {
  await addTournament(1, 'Started Bracket Major');
  await db.runAsync(
    `INSERT INTO bracket_history (tournament_id, game_id, startgg_set_id, round_text, state) VALUES (1, 10, 's1', 'Losers Round 2', 'in_progress')`
  );

  const [{ tournament }] = await lm.getUpcoming();
  assert.equal(!!tournament.hasLiveRound, true);
});

test('hasLiveRound is false when scheduled start has passed but no set has started', async () => {
  await addTournament(2, 'Delayed Bracket Major');
  await db.runAsync(
    `INSERT INTO bracket_history (tournament_id, game_id, startgg_set_id, round_text, state) VALUES (2, 10, 's2', 'Losers Round 1', 'pending')`
  );

  const [{ tournament }] = await lm.getUpcoming();
  assert.equal(!!tournament.hasLiveRound, false);
});
