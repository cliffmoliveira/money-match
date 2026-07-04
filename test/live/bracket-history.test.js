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

test('classifyRoundStatus: done only when every set is state 3', () => {
  assert.equal(syncLive.classifyRoundStatus([{ state: 3 }, { state: 3 }]), 'done');
  assert.equal(syncLive.classifyRoundStatus([{ state: 3 }, { state: 2 }]), 'live');
  assert.equal(syncLive.classifyRoundStatus([{ state: 1 }, { state: 1 }]), 'live');
  assert.equal(syncLive.classifyRoundStatus([]), 'live');
});

test('groupSetsIntoRounds: collapses pools phases into one "Pools" group', () => {
  const phases = [
    { eventId: 1, phaseOrder: 1, phaseName: 'Pool A', sets: [{ id: 's1', state: 3, fullRoundText: 'Pool A Round 1', round: 1 }] },
    { eventId: 1, phaseOrder: 1, phaseName: 'Pool B', sets: [{ id: 's2', state: 2, fullRoundText: 'Pool B Round 1', round: 1 }] },
    { eventId: 1, phaseOrder: 2, phaseName: 'Bracket', sets: [{ id: 's3', state: 1, fullRoundText: 'Winners Round 1', round: 1 }] },
  ];
  const groups = syncLive.groupSetsIntoRounds(phases);
  const pools = groups.find((g) => g.roundText === 'Pools');
  assert.ok(pools, 'expected a single Pools group');
  assert.equal(pools.sets.length, 2);
  assert.equal(pools.roundInt, null);
  assert.equal(pools.phaseOrder, 1);

  const bracket = groups.find((g) => g.roundText === 'Winners Round 1');
  assert.ok(bracket);
  assert.equal(bracket.sets.length, 1);
  assert.equal(bracket.roundInt, 1);
});

test('groupSetsIntoRounds: bracket-phase sets group by round text, not individually per set', () => {
  const phases = [
    {
      eventId: 1, phaseOrder: 2, phaseName: 'Bracket',
      sets: [
        { id: 's1', state: 3, fullRoundText: 'Winners Round 1', round: 1 },
        { id: 's2', state: 3, fullRoundText: 'Winners Round 1', round: 1 },
        { id: 's3', state: 1, fullRoundText: 'Winners Round 2', round: 2 },
      ],
    },
  ];
  const groups = syncLive.groupSetsIntoRounds(phases);
  assert.equal(groups.length, 2);
  const r1 = groups.find((g) => g.roundText === 'Winners Round 1');
  assert.equal(r1.sets.length, 2);
});
