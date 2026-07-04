const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let db, syncLive, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-bh-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  delete require.cache[require.resolve('../../scripts/sync-live')];
  db = require('../../db/db');
  syncLive = require('../../scripts/sync-live');
  // db/db.js's own boot process already creates bracket_history (IF NOT
  // EXISTS) as soon as require('../../db/db') runs above — match that here
  // so this doesn't collide with it.
  await db.runAsync(`CREATE TABLE IF NOT EXISTS bracket_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER,
    startgg_set_id TEXT UNIQUE, round_text TEXT, round_int INTEGER, phase_order INTEGER,
    state TEXT, player1_id INTEGER, player2_id INTEGER, winner_id INTEGER,
    player1_score INTEGER, player2_score INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await db.runAsync(`CREATE TABLE set_markets (id INTEGER PRIMARY KEY, startgg_set_id TEXT, state TEXT)`);
  await db.runAsync(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, country TEXT, startgg_id TEXT, photo_url TEXT)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM bracket_history');
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync('DELETE FROM players');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

test('isPoolsPhase matches common pools phase names, case-insensitively', () => {
  assert.equal(syncLive.isPoolsPhase('Pools'), true);
  assert.equal(syncLive.isPoolsPhase('Pool A'), true);
  assert.equal(syncLive.isPoolsPhase('pool b'), true);
  assert.equal(syncLive.isPoolsPhase('Winners Round 1'), false);
  assert.equal(syncLive.isPoolsPhase('Top 8'), false);
  assert.equal(syncLive.isPoolsPhase(undefined), false);
  assert.equal(syncLive.isPoolsPhase(''), false);
});
