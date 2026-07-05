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

test('resolveFinalPhase prefers a phase literally named "Top 8" over the highest phaseOrder', () => {
  // Real-world quirk: a later-created "Top 16" consolidation phase can end
  // up with a higher phaseOrder than the phase actually named "Top 8", even
  // though "Top 8" is the true final stage.
  const phases = [
    { id: 1, name: 'Bracket Play', phaseOrder: 1 },
    { id: 2, name: 'Top 8', phaseOrder: 2 },
    { id: 3, name: 'Top 16', phaseOrder: 3 },
  ];
  assert.equal(syncLive.resolveFinalPhase(phases).id, 2);
});

test('resolveFinalPhase matches "Top 8" case-insensitively and with no space', () => {
  assert.equal(syncLive.resolveFinalPhase([
    { id: 1, name: 'Pools', phaseOrder: 1 },
    { id: 2, name: 'top8', phaseOrder: 2 },
  ]).id, 2);
});

test('resolveFinalPhase falls back to highest phaseOrder when no phase is named "Top 8"', () => {
  assert.equal(syncLive.resolveFinalPhase([
    { id: 1, name: 'Pools', phaseOrder: 1 },
    { id: 2, name: 'Bracket', phaseOrder: 2 },
  ]).id, 2);
});

test('classifyRoundStatus: done when every set is state 3, live once any set has started, next when none have', () => {
  assert.equal(syncLive.classifyRoundStatus([{ state: 3 }, { state: 3 }]), 'done');
  assert.equal(syncLive.classifyRoundStatus([{ state: 3 }, { state: 2 }]), 'live');
  assert.equal(syncLive.classifyRoundStatus([{ state: 2 }, { state: 1 }]), 'live');
  // A pre-generated bracket shell reports every future round's sets as state 1
  // (pending) long before they start - that must read as "next", not "live".
  assert.equal(syncLive.classifyRoundStatus([{ state: 1 }, { state: 1 }]), 'next');
  assert.equal(syncLive.classifyRoundStatus([]), 'next');
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

test('processHistorySets writes one bracket_history row per set, never touching set_markets', async () => {
  const roundGroup = {
    roundText: 'Winners Round 1', roundInt: 1, phaseOrder: 2,
    sets: [{
      id: 'hset1', state: 3, fullRoundText: 'Winners Round 1', round: 1,
      winnerId: 'e1',
      slots: [
        { entrant: { id: 'e1', name: 'GranTODAKAI', seeds: [{ seedNum: 1 }] }, standing: { stats: { score: { value: 3 } } } },
        { entrant: { id: 'e2', name: 'Alioune', seeds: [{ seedNum: 17 }] }, standing: { stats: { score: { value: 1 } } } },
      ],
    }],
  };

  await syncLive.processHistorySets({ id: 1 }, 10, [roundGroup]);

  const rows = await db.allAsync('SELECT * FROM bracket_history');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].startgg_set_id, 'hset1');
  assert.equal(rows[0].round_text, 'Winners Round 1');
  assert.equal(rows[0].state, 'completed');
  assert.equal(rows[0].player1_score, 3);
  assert.equal(rows[0].player2_score, 1);

  const marketRows = await db.allAsync('SELECT * FROM set_markets');
  assert.equal(marketRows.length, 0, 'processHistorySets must never write to set_markets');
});

test('processHistorySets removes stale rows for a round whose set ids start.gg no longer reports', async () => {
  // Confirmed live against Esports World Cup 2026 FATAL FURY LCQ: a bracket
  // regeneration reassigned new start.gg set ids to the same logical Top 16
  // matches, leaving the old ids stuck at 'pending' in bracket_history
  // forever (upsert-by-id never deletes an id that stops appearing), so a
  // fully finished round kept reading as unfinished — status stuck "live"
  // instead of "done" because not every stored set for the round was 'done'.
  await db.runAsync(
    `INSERT INTO bracket_history (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_order, state)
     VALUES (1, 10, 'orphaned-old-id', 'Winners Quarter-Final', 1, 2, 'pending')`
  );

  const roundGroup = {
    roundText: 'Winners Quarter-Final', roundInt: 1, phaseOrder: 2,
    sets: [{
      id: 'fresh-current-id', state: 3, fullRoundText: 'Winners Quarter-Final', round: 1,
      winnerId: 'e1',
      slots: [
        { entrant: { id: 'e1', name: 'Gummy', seeds: [{ seedNum: 1 }] }, standing: { stats: { score: { value: 2 } } } },
        { entrant: { id: 'e2', name: 'Alioune', seeds: [{ seedNum: 8 }] }, standing: { stats: { score: { value: 0 } } } },
      ],
    }],
  };

  await syncLive.processHistorySets({ id: 1 }, 10, [roundGroup]);

  const rows = await db.allAsync(
    `SELECT startgg_set_id, state FROM bracket_history WHERE tournament_id = 1 AND game_id = 10 AND round_text = 'Winners Quarter-Final'`
  );
  assert.equal(rows.length, 1, 'the orphaned set id should be removed, leaving only the current one');
  assert.equal(rows[0].startgg_set_id, 'fresh-current-id');
  assert.equal(rows[0].state, 'completed');
});
