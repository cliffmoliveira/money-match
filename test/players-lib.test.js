const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Regression coverage for scripts/lib/players.js's identity resolution,
// including the player_startgg_aliases path added after the xiaohai
// duplicate-account bug (2026-07-26): the same real person competing under
// two different start.gg accounts (no shared participant.player.id, no
// matching exact name) used to get a fresh players row every time, silently
// hiding all newer results from anyone following the original row.
let db, lib, file;

function entrant({ name, playerId, entrantId = 999 }) {
  return {
    name,
    id: entrantId,
    participants: playerId != null ? [{ player: { id: playerId } }] : [],
  };
}

before(async () => {
  file = path.join(os.tmpdir(), `mm-players-lib-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../db/db')];
  delete require.cache[require.resolve('../scripts/lib/players')];
  db = require('../db/db');
  lib = require('../scripts/lib/players');
  // player_startgg_aliases is created by db/db.js's own boot (CREATE TABLE
  // IF NOT EXISTS) as soon as require('../db/db') runs above.
  await db.runAsync(`CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, country TEXT NOT NULL DEFAULT '', startgg_id INTEGER, photo_url TEXT)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM players');
  await db.runAsync('DELETE FROM player_startgg_aliases');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

test('creates a new player when nothing matches', async () => {
  const id = await lib.findOrCreatePlayerId(entrant({ name: 'Fresh Player', playerId: 111 }));
  const row = await db.getAsync('SELECT * FROM players WHERE id = ?', [id]);
  assert.equal(row.name, 'Fresh Player');
  assert.equal(row.startgg_id, 111);
});

test('exact startgg_id match reuses the row without touching it', async () => {
  const { lastID } = await db.runAsync('INSERT INTO players (name, startgg_id) VALUES (?, ?)', ['Some Tag', 222]);
  const id = await lib.findOrCreatePlayerId(entrant({ name: 'Some Tag (renamed)', playerId: 222 }));
  assert.equal(id, lastID);
});

test('exact name match self-heals a stale/pre-fix startgg_id', async () => {
  const { lastID } = await db.runAsync('INSERT INTO players (name, startgg_id) VALUES (?, ?)', ['WBG RB | MenaRD', 555]);
  // Same real person, but the stable participant.player.id has changed from
  // whatever stale value (an old entrant.id) was stored originally.
  const id = await lib.findOrCreatePlayerId(entrant({ name: 'WBG RB | MenaRD', playerId: 224650 }));
  assert.equal(id, lastID);
  const row = await db.getAsync('SELECT startgg_id FROM players WHERE id = ?', [lastID]);
  assert.equal(row.startgg_id, 224650);
});

test('a known alias resolves to the canonical row without overwriting its primary startgg_id', async () => {
  const { lastID: canonicalId } = await db.runAsync(
    'INSERT INTO players (name, startgg_id) VALUES (?, ?)',
    ['FALCONS | xiaohai', 4004146]
  );
  await db.runAsync('INSERT INTO player_startgg_aliases (player_id, startgg_id) VALUES (?, ?)', [canonicalId, 5479000]);

  // A future sync under the OTHER (previously merged-away) start.gg account -
  // different name string, different player.id, no direct match at all.
  const id = await lib.findOrCreatePlayerId(entrant({ name: 'Falcons丨Xiaohai', playerId: 5479000 }));
  assert.equal(id, canonicalId);

  // Primary identity must be untouched - overwriting it would just move the
  // duplicate-recreation problem onto the OTHER account instead of fixing it.
  const row = await db.getAsync('SELECT startgg_id FROM players WHERE id = ?', [canonicalId]);
  assert.equal(row.startgg_id, 4004146);
});
