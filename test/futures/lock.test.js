const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// futures.js reads a module-level db handle, so wire a fresh temp DB and require
// the module AFTER setting DATABASE_PATH (mirrors test/live/upcoming.test.js).
let db, futures, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-futures-lock-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  delete require.cache[require.resolve('../../futures')];
  db = require('../../db/db');
  futures = require('../../futures');
  await db.runAsync('CREATE TABLE tournaments (id INTEGER PRIMARY KEY, name TEXT, date TEXT)');
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM tournaments');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

async function addTournament(id, date) {
  await db.runAsync('INSERT INTO tournaments (id, name, date) VALUES (?,?,?)', [id, `T${id}`, date]);
}

test('a future-dated tournament is open (futures not locked)', async () => {
  await addTournament(1, '2099-12-31');
  assert.deepEqual(await futures.isFuturesLocked(1), { found: true, locked: false });
});

test('a past-dated tournament is locked', async () => {
  await addTournament(2, '2000-01-01');
  assert.deepEqual(await futures.isFuturesLocked(2), { found: true, locked: true });
});

test('a tournament starting today is locked (closes at the start of the event day)', async () => {
  const { d } = await db.getAsync("SELECT DATE('now') AS d");
  await addTournament(3, d);
  assert.deepEqual(await futures.isFuturesLocked(3), { found: true, locked: true });
});

test('an unknown tournament reports not found', async () => {
  assert.deepEqual(await futures.isFuturesLocked(999), { found: false, locked: false });
});
