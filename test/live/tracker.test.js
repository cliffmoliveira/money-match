const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let db, lm, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-tracker-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  delete require.cache[require.resolve('../../liveMarkets')];
  db = require('../../db/db');
  lm = require('../../liveMarkets');
  await db.runAsync(`CREATE TABLE IF NOT EXISTS bracket_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER,
    startgg_set_id TEXT UNIQUE, round_text TEXT, round_int INTEGER, phase_order INTEGER,
    state TEXT, player1_id INTEGER, player2_id INTEGER, winner_id INTEGER,
    player1_score INTEGER, player2_score INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await db.runAsync(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT)`);
  await db.runAsync(`CREATE TABLE players_games_tournaments (tournament_id INTEGER, game_id INTEGER, player_id INTEGER, seed_num INTEGER)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM bracket_history');
  await db.runAsync('DELETE FROM players');
  await db.runAsync('DELETE FROM players_games_tournaments');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

async function addPlayer(id, name) { await db.runAsync('INSERT INTO players (id, name) VALUES (?,?)', [id, name]); }
async function addHistory(row) {
  await db.runAsync(
    `INSERT INTO bracket_history
       (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_order, state, player1_id, player2_id, winner_id, player1_score, player2_score)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.tournamentId, row.gameId, row.setId, row.roundText, row.roundInt ?? null, row.phaseOrder ?? 0,
      row.state, row.p1, row.p2, row.winner ?? null, row.s1 ?? null, row.s2 ?? null]
  );
}
async function seedPlayer(tournamentId, gameId, playerId, seedNum) {
  await db.runAsync('INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, seed_num) VALUES (?,?,?,?)',
    [tournamentId, gameId, playerId, seedNum]);
}

test('getGameTracker groups rounds by status and lists results newest-first', async () => {
  await addPlayer(1, 'GranTODAKAI'); await addPlayer(2, 'Alioune');
  await addHistory({ tournamentId: 1, gameId: 10, setId: 's1', roundText: 'Winners Round 1', roundInt: 1, phaseOrder: 2, state: 'completed', p1: 1, p2: 2, winner: 1, s1: 3, s2: 1 });
  await addHistory({ tournamentId: 1, gameId: 10, setId: 's2', roundText: 'Winners Round 2', roundInt: 2, phaseOrder: 2, state: 'in_progress', p1: 1, p2: 2 });

  const result = await lm.getGameTracker(1, 10);
  assert.deepEqual(result.rounds.map((r) => r.roundText), ['Winners Round 1', 'Winners Round 2']);
  assert.equal(result.rounds.find((r) => r.roundText === 'Winners Round 1').status, 'done');
  assert.equal(result.rounds.find((r) => r.roundText === 'Winners Round 2').status, 'live');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].winner, 'GranTODAKAI');
  assert.equal(result.results[0].loser, 'Alioune');
  assert.equal(result.results[0].score, '3-1');
});

test('getGameTracker marks a round "next" when every set in it is still pending', async () => {
  await addPlayer(1, 'GranTODAKAI'); await addPlayer(2, 'Alioune');
  await addHistory({ tournamentId: 1, gameId: 10, setId: 's1', roundText: 'Winners Round 1', roundInt: 1, phaseOrder: 2, state: 'pending', p1: 1, p2: 2 });

  const result = await lm.getGameTracker(1, 10);
  assert.equal(result.rounds.find((r) => r.roundText === 'Winners Round 1').status, 'next');
});

test('getGameTracker stillAlive excludes anyone who has lost a completed set', async () => {
  await addPlayer(1, 'GranTODAKAI'); await addPlayer(2, 'Alioune');
  await seedPlayer(1, 10, 1, 1);
  await seedPlayer(1, 10, 2, 17);
  await addHistory({ tournamentId: 1, gameId: 10, setId: 's1', roundText: 'Winners Round 1', roundInt: 1, phaseOrder: 2, state: 'completed', p1: 1, p2: 2, winner: 1, s1: 3, s2: 1 });

  const result = await lm.getGameTracker(1, 10);
  assert.deepEqual(result.stillAlive.map((p) => p.name), ['GranTODAKAI']);
});

test('getGameTracker returns empty arrays when nothing is tracked yet', async () => {
  const result = await lm.getGameTracker(999, 999);
  assert.deepEqual(result.rounds, []);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.stillAlive, []);
});
