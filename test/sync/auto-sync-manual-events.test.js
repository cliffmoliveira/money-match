const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// resolveBareTag is the safety-critical piece: it's the ONLY thing standing
// between a bare Liquipedia gamertag and this app's "SPONSOR | tag" players
// table, with no human review in the loop. A false-positive match here means
// auto-attributing a real result to the wrong real person.
let db, autoSync, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-autosync-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  for (const m of ['../../db/db', '../../scripts/auto-sync-manual-events', '../../scripts/ingest-manual-results', '../../scripts/fetch-liquipedia-bracket']) {
    delete require.cache[require.resolve(m)];
  }
  db = require('../../db/db');
  autoSync = require('../../scripts/auto-sync-manual-events');
  await db.runAsync(`CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, country TEXT NOT NULL DEFAULT '', startgg_id INTEGER, photo_url TEXT)`);
  await db.runAsync(`CREATE TABLE tournaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, date DATE NOT NULL, city TEXT, country TEXT, winner_id INTEGER, startgg_id INTEGER, logo_url TEXT, is_live INTEGER NOT NULL DEFAULT 0)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM players');
  await db.runAsync('DELETE FROM tournaments');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

test('resolves a bare tag to the one player whose last sponsor-tag segment matches exactly', async () => {
  await db.runAsync("INSERT INTO players (name) VALUES ('REJECT | Laggia'), ('T1 | ZJZ')");
  const match = await autoSync.resolveBareTag('Laggia');
  assert.equal(match.name, 'REJECT | Laggia');
});

test('refuses to auto-resolve when the tag is genuinely ambiguous (multiple candidates)', async () => {
  await db.runAsync("INSERT INTO players (name) VALUES ('Falcons | mok'), ('VARREL | mok')");
  const match = await autoSync.resolveBareTag('mok');
  assert.equal(match, null);
});

test('never false-positives on a tag that only appears as a substring of an unrelated name', async () => {
  // Real near-miss found manually earlier: Liquipedia's "Xian" must not match
  // a completely unrelated player whose name merely contains "xian" as a
  // substring (e.g. "waktuxiang").
  await db.runAsync("INSERT INTO players (name) VALUES ('waktuxiang'), ('Nemesis | Xian')");
  const match = await autoSync.resolveBareTag('Xian');
  assert.equal(match.name, 'Nemesis | Xian');
});

test('matches case-insensitively and across every real separator style', async () => {
  await db.runAsync("INSERT INTO players (name) VALUES ('WBG PWS丨 | NaiWang')");
  const match = await autoSync.resolveBareTag('naiwang');
  assert.equal(match.name, 'WBG PWS丨 | NaiWang');
});

test('returns null when no candidate exists at all', async () => {
  const match = await autoSync.resolveBareTag('TotallyUnknownPlayer');
  assert.equal(match, null);
});

test('syncOneEvent skips an already-finalized tournament without any network call', async () => {
  await db.runAsync(
    "INSERT INTO tournaments (name, date, winner_id) VALUES ('Esports World Cup 2026: FATAL FURY: City of the Wolves', '2026-07-11', 1)"
  );
  const entry = autoSync.REGISTRY.find((e) => e.manualId === 'ewc-2026-ffcotw');
  const result = await autoSync.syncOneEvent(entry);
  assert.equal(result.status, 'already-finalized');
});
