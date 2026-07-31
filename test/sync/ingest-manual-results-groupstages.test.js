const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Coverage for the groupStages[] addition to ingest-manual-results.js -
// pre-Top-8 bracket progress (display only, see
// scripts/fetch-liquipedia-bracket.js), written to bracket_history rather
// than set_markets (no odds/pools/money either way).
//
// main() closes its own DB connection on completion (correct for a real
// one-shot CLI run) - reconnect() re-requires both modules fresh, exactly
// like a second `node ingest-manual-results.js` invocation would.
let db, ingest, file;

function reconnect() {
  for (const m of ['../../db/db', '../../scripts/ingest-manual-results']) {
    delete require.cache[require.resolve(m)];
  }
  db = require('../../db/db');
  ingest = require('../../scripts/ingest-manual-results');
}

before(async () => {
  file = path.join(os.tmpdir(), `mm-ingest-gs-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  reconnect();
  // player_startgg_aliases/bracket_history/app_state are created by db/db.js's
  // own boot (CREATE TABLE IF NOT EXISTS) as soon as require('../../db/db') runs.
  await db.runAsync(`CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, country TEXT NOT NULL DEFAULT '', startgg_id INTEGER, photo_url TEXT)`);
  await db.runAsync(`CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, startgg_id INTEGER)`);
  await db.runAsync(`CREATE TABLE tournaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, date DATE NOT NULL, city TEXT, country TEXT, winner_id INTEGER, startgg_id INTEGER, logo_url TEXT, is_live INTEGER NOT NULL DEFAULT 0)`);
  await db.runAsync(`CREATE TABLE tournament_games (tournament_id INTEGER NOT NULL, game_id INTEGER NOT NULL, num_entrants INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (tournament_id, game_id))`);
  await db.runAsync(`CREATE TABLE set_markets (id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER, startgg_set_id TEXT UNIQUE, round_text TEXT, player1_id INTEGER, player2_id INTEGER, state TEXT NOT NULL DEFAULT 'open', p1_prob REAL, p2_prob REAL, seed_k_cents INTEGER, p1_pool_cents INTEGER DEFAULT 0, p2_pool_cents INTEGER DEFAULT 0, p1_live_odds REAL, p2_live_odds REAL, winner_id INTEGER, opened_at TEXT, closed_at TEXT, settled_at TEXT, round_int INTEGER, p1_score INTEGER, p2_score INTEGER)`);
  await db.runAsync(`CREATE TABLE matches (id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER NOT NULL, game_id INTEGER NOT NULL, player1_id INTEGER NOT NULL, player2_id INTEGER NOT NULL, winner_id INTEGER NOT NULL, loser_id INTEGER NOT NULL, player1RoundsWon INTEGER NOT NULL, player2RoundsWon INTEGER NOT NULL, startgg_id INTEGER)`);

  await db.runAsync("INSERT INTO players (name) VALUES ('A'), ('B'), ('C'), ('D')");
  await db.runAsync("INSERT INTO games (name) VALUES ('Test Game')");
});

beforeEach(async () => {
  reconnect();
  await db.runAsync('DELETE FROM tournaments');
  await db.runAsync('DELETE FROM tournament_games');
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync('DELETE FROM matches');
  await db.runAsync('DELETE FROM bracket_history');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

function writeSpec(obj) {
  const specPath = path.join(os.tmpdir(), `mm-ingest-gs-spec-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(specPath, JSON.stringify(obj));
  return specPath;
}

const BASE_SETS = [
  { n: 1, round: 'Grand Final', roundInt: 3, p1: 'A', p2: 'B', p1Score: 3, p2Score: 1, at: '2026-01-01 00:00:00' },
];

test('writes groupStages as bracket_history rows, nullable score allowed alongside a known winner', async () => {
  const spec = {
    manualId: 'test-gs-1',
    tournament: { name: 'Test Event 1', date: '2026-01-01', city: 'X', country: 'Y' },
    game: 'Test Game', numEntrants: 4, sets: BASE_SETS,
    groupStages: [
      { n: 1, round: 'Group Stage 1', phaseOrder: 0, p1: 'C', p2: 'D', p1Score: 2, p2Score: 1, winner: 1 },
      { n: 2, round: 'Group Stage 1', phaseOrder: 0, p1: 'A', p2: 'C', p1Score: null, p2Score: null, winner: 1 },
    ],
  };
  process.argv = ['node', 'ingest-manual-results.js', writeSpec(spec)];
  await ingest.main();
  reconnect();

  const rows = await db.allAsync('SELECT * FROM bracket_history ORDER BY startgg_set_id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].round_text, 'Group Stage 1');
  assert.equal(rows[0].state, 'completed');
  assert.equal(rows[1].player1_score, null);
  assert.equal(rows[1].player2_score, null);
  assert.ok(rows[1].winner_id != null); // winner still known despite missing scores
});

test('re-running is idempotent - no duplicate bracket_history rows', async () => {
  const spec = {
    manualId: 'test-gs-2',
    tournament: { name: 'Test Event 2', date: '2026-01-01', city: 'X', country: 'Y' },
    game: 'Test Game', numEntrants: 4, sets: BASE_SETS,
    groupStages: [{ n: 1, round: 'Group Stage 1', phaseOrder: 0, p1: 'C', p2: 'D', p1Score: 2, p2Score: 1, winner: 1 }],
  };
  const p = writeSpec(spec);
  process.argv = ['node', 'ingest-manual-results.js', p];
  await ingest.main();
  reconnect();
  process.argv = ['node', 'ingest-manual-results.js', p];
  await ingest.main();
  reconnect();

  const rows = await db.allAsync('SELECT * FROM bracket_history');
  assert.equal(rows.length, 1);
});

test('rejects a groupStages entry with an invalid winner value', async () => {
  const spec = {
    manualId: 'test-gs-3',
    tournament: { name: 'Test Event 3', date: '2026-01-01', city: 'X', country: 'Y' },
    game: 'Test Game', numEntrants: 4, sets: BASE_SETS,
    groupStages: [{ n: 1, round: 'Group Stage 1', phaseOrder: 0, p1: 'C', p2: 'D', p1Score: 2, p2Score: 1, winner: 3 }],
  };
  process.argv = ['node', 'ingest-manual-results.js', writeSpec(spec)];
  await assert.rejects(() => ingest.main(), /winner must be 1 or 2/);
});
