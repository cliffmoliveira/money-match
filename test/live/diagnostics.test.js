const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// db.js runs its read-only diagnostics (including diagnosePreviewOnlyGames
// and diagnoseMultiEventGames) against whatever DATABASE_PATH is set to at
// require-time, and attaches them as callable functions on the exported db
// object - same pattern this suite uses to test them against a real schema
// instead of mocking the query logic.
let db, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-diag-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  db = require('../../db/db');

  await db.runAsync(`CREATE TABLE tournaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, date TEXT, is_live INTEGER NOT NULL DEFAULT 0, startgg_id TEXT)`);
  await db.runAsync(`CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, startgg_id TEXT)`);
  await db.runAsync(`CREATE TABLE set_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER, startgg_set_id TEXT,
    round_text TEXT, state TEXT NOT NULL DEFAULT 'open',
    startgg_event_id TEXT, startgg_event_name TEXT)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync('DELETE FROM games');
  await db.runAsync('DELETE FROM tournaments');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

test('diagnosePreviewOnlyGames flags a game whose only markets are void previews at a recently-started tournament', async () => {
  const t = await db.runAsync(`INSERT INTO tournaments (name, date) VALUES ('VSFighting XIV', datetime('now', '-1 day'))`);
  const g = await db.runAsync(`INSERT INTO games (name) VALUES ('Guilty Gear: Strive')`);
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state) VALUES (?, ?, 'preview_1_1_0', 'void')`,
    [t.lastID, g.lastID]
  );

  const found = db.diagnosePreviewOnlyGames('[test]');
  assert.equal(found.length, 1);
  assert.equal(found[0].game_name, 'Guilty Gear: Strive');
});

test('diagnosePreviewOnlyGames ignores a game that also has a real market', async () => {
  const t = await db.runAsync(`INSERT INTO tournaments (name, date) VALUES ('VSFighting XIV', datetime('now', '-1 day'))`);
  const g = await db.runAsync(`INSERT INTO games (name) VALUES ('TEKKEN 8')`);
  await db.runAsync(`INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state) VALUES (?, ?, 'preview_1_1_0', 'void')`, [t.lastID, g.lastID]);
  await db.runAsync(`INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state) VALUES (?, ?, 'real-1', 'open')`, [t.lastID, g.lastID]);

  assert.equal(db.diagnosePreviewOnlyGames('[test]').length, 0);
});

test('diagnosePreviewOnlyGames ignores a tournament that started too long ago', async () => {
  const t = await db.runAsync(`INSERT INTO tournaments (name, date) VALUES ('Old Major', datetime('now', '-10 day'))`);
  const g = await db.runAsync(`INSERT INTO games (name) VALUES ('Guilty Gear: Strive')`);
  await db.runAsync(`INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state) VALUES (?, ?, 'preview_1_1_0', 'void')`, [t.lastID, g.lastID]);

  assert.equal(db.diagnosePreviewOnlyGames('[test]').length, 0);
});

test('diagnoseMultiEventGames flags a game whose real markets span more than one start.gg event', async () => {
  // Reproduces the VSFighting XIV bug: "Tekken Ball" (a bonus minigame) and
  // the real "TEKKEN 8 (TWT Master Event)" bracket share the same videogame,
  // so their sets merged into one game_id with no way to tell them apart -
  // until now, since fillBracketSlot persists which event each came from.
  const t = await db.runAsync(`INSERT INTO tournaments (name, date) VALUES ('VSFighting XIV', datetime('now'))`);
  const g = await db.runAsync(`INSERT INTO games (name) VALUES ('TEKKEN 8')`);
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state, startgg_event_id, startgg_event_name)
     VALUES (?, ?, 'real-t8-1', 'open', 'evt-real', 'TEKKEN 8 (TEKKEN WORLD TOUR 2026 MASTER EVENT)')`,
    [t.lastID, g.lastID]
  );
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state, startgg_event_id, startgg_event_name)
     VALUES (?, ?, 'tball-1', 'settled', 'evt-tball', 'TEKKEN BALL (hosted by DQRetro)')`,
    [t.lastID, g.lastID]
  );

  const found = db.diagnoseMultiEventGames('[test]');
  assert.equal(found.length, 1);
  assert.equal(found[0].event_count, 2);
  assert.match(found[0].event_names, /TEKKEN BALL/);
  assert.match(found[0].event_names, /MASTER EVENT/);
});

test('diagnoseMultiEventGames ignores a game whose real markets all share one event', async () => {
  const t = await db.runAsync(`INSERT INTO tournaments (name, date) VALUES ('VSFighting XIV', datetime('now'))`);
  const g = await db.runAsync(`INSERT INTO games (name) VALUES ('TEKKEN 8')`);
  for (const setId of ['real-t8-1', 'real-t8-2']) {
    await db.runAsync(
      `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state, startgg_event_id, startgg_event_name)
       VALUES (?, ?, ?, 'open', 'evt-real', 'TEKKEN 8 (TEKKEN WORLD TOUR 2026 MASTER EVENT)')`,
      [t.lastID, g.lastID, setId]
    );
  }

  assert.equal(db.diagnoseMultiEventGames('[test]').length, 0);
});

test('diagnoseMultiEventGames ignores void rows and rows with no event id recorded yet', async () => {
  const t = await db.runAsync(`INSERT INTO tournaments (name, date) VALUES ('VSFighting XIV', datetime('now'))`);
  const g = await db.runAsync(`INSERT INTO games (name) VALUES ('TEKKEN 8')`);
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state, startgg_event_id, startgg_event_name)
     VALUES (?, ?, 'real-t8-1', 'open', 'evt-real', 'TEKKEN 8 (TEKKEN WORLD TOUR 2026 MASTER EVENT)')`,
    [t.lastID, g.lastID]
  );
  // A stale voided row from a different event must not count.
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state, startgg_event_id, startgg_event_name)
     VALUES (?, ?, 'tball-1', 'void', 'evt-tball', 'TEKKEN BALL (hosted by DQRetro)')`,
    [t.lastID, g.lastID]
  );
  // A row written before this migration (no event id yet) must not count either.
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state) VALUES (?, ?, 'legacy-1', 'settled')`,
    [t.lastID, g.lastID]
  );

  assert.equal(db.diagnoseMultiEventGames('[test]').length, 0);
});
