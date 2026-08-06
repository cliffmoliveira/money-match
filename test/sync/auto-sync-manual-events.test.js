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
const realFetch = global.fetch;

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
  await db.runAsync(`CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`);
  await db.runAsync(`CREATE TABLE tournament_games (tournament_id INTEGER, game_id INTEGER, num_entrants INTEGER)`);
  await db.runAsync("INSERT INTO games (name) VALUES ('Fatal Fury: City of the Wolves'), ('Street Fighter 6'), ('TEKKEN 8')");
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM players');
  await db.runAsync('DELETE FROM tournaments');
  await db.runAsync('DELETE FROM tournament_games');
  global.fetch = realFetch;
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

function wikitextResponse(sdate) {
  return {
    ok: true,
    json: async () => ({ parse: { wikitext: { '*': sdate ? `{{Infobox league\n|sdate=${sdate}\n|edate=2026-08-07\n}}` : '{{Infobox league\n}}' } } }),
  };
}

test('seedUpcomingTournament writes a bare tournaments + tournament_games row using the infobox start date', async () => {
  global.fetch = async () => wikitextResponse('2026-08-06');
  const entry = autoSync.REGISTRY.find((e) => e.manualId === 'ewc-2026-t8');

  const id = await autoSync.seedUpcomingTournament(entry);
  assert.ok(id);

  const row = await db.getAsync('SELECT * FROM tournaments WHERE id = ?', [id]);
  assert.equal(row.name, entry.tournament.name);
  assert.equal(row.date, '2026-08-06');
  assert.equal(row.startgg_id, null);
  assert.equal(row.winner_id, null);
  assert.equal(row.is_live, 0);

  const tg = await db.getAsync('SELECT * FROM tournament_games WHERE tournament_id = ?', [id]);
  assert.equal(tg.num_entrants, entry.numEntrants);
});

test('seedUpcomingTournament gives up cleanly when the infobox has no sdate yet', async () => {
  global.fetch = async () => wikitextResponse(null);
  const entry = autoSync.REGISTRY.find((e) => e.manualId === 'ewc-2026-t8');

  const id = await autoSync.seedUpcomingTournament(entry);
  assert.equal(id, null);
  const row = await db.getAsync('SELECT * FROM tournaments WHERE name = ?', [entry.tournament.name]);
  assert.equal(row, undefined);
});

test('syncOneEvent leaves an already-seeded row alone once its start date has passed with nothing decided yet', async () => {
  // Deliberately NOT flipping is_live here: scripts/sync-live.js's 60s
  // auto-clear sweep resets is_live=0 for any tournament with zero
  // unresolved set_markets rows (see its own "Auto-clear is_live" comment),
  // which describes every freshly-seeded manual event - toggling is_live
  // here would just get stomped by that sweep a minute later. Visibility
  // for this case is getUpcoming()'s job (see its own bridge-window test).
  const entry = autoSync.REGISTRY.find((e) => e.manualId === 'ewc-2026-t8');
  await db.runAsync(
    'INSERT INTO tournaments (name, date, is_live) VALUES (?, ?, 0)',
    [entry.tournament.name, '2000-01-01']
  );
  global.fetch = async () => ({ ok: true, json: async () => ({ parse: { text: { '*': '<div></div>' } } }) });

  const result = await autoSync.syncOneEvent(entry);
  assert.equal(result.status, 'not-ready');
  const row = await db.getAsync('SELECT is_live FROM tournaments WHERE name = ?', [entry.tournament.name]);
  assert.equal(row.is_live, 0);
});

test('diagnoseMissingRegistryEntries warns about an EWC edition/game synced via start.gg with no REGISTRY entry', async () => {
  await db.runAsync("INSERT INTO games (name) VALUES ('Guilty Gear Strive')");
  const game = await db.getAsync("SELECT id FROM games WHERE name = 'Guilty Gear Strive'");
  await db.runAsync(
    "INSERT INTO tournaments (name, date, startgg_id) VALUES ('Esports World Cup 2027: Guilty Gear Strive - LCQ', '2027-08-01', 999)"
  );
  const t = await db.getAsync("SELECT id FROM tournaments WHERE name LIKE 'Esports World Cup 2027%'");
  await db.runAsync('INSERT INTO tournament_games (tournament_id, game_id) VALUES (?, ?)', [t.id, game.id]);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await autoSync.diagnoseMissingRegistryEntries();
  } finally {
    console.warn = origWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Guilty Gear Strive 2027/);
  assert.match(warnings[0], /no REGISTRY entry/);
});

test('diagnoseMissingRegistryEntries stays silent when every synced EWC edition/game has a REGISTRY entry', async () => {
  const game = await db.getAsync("SELECT id FROM games WHERE name = 'TEKKEN 8'");
  await db.runAsync(
    "INSERT INTO tournaments (name, date, startgg_id) VALUES ('Esports World Cup 2026: TEKKEN 8 - LCQ', '2026-08-01', 998)"
  );
  const t = await db.getAsync("SELECT id FROM tournaments WHERE name LIKE 'Esports World Cup 2026: TEKKEN 8 - LCQ'");
  await db.runAsync('INSERT INTO tournament_games (tournament_id, game_id) VALUES (?, ?)', [t.id, game.id]);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await autoSync.diagnoseMissingRegistryEntries();
  } finally {
    console.warn = origWarn;
  }

  assert.equal(warnings.length, 0);
});

test('syncOneEvent seeds an upcoming entry when a brand-new event has no decided sets or groups yet', async () => {
  global.fetch = async (url) => {
    if (String(url).includes('prop=wikitext')) return wikitextResponse('2026-08-06');
    // Rendered-page fetch (prop=text): an empty page, no brackets started.
    return { ok: true, json: async () => ({ parse: { text: { '*': '<div></div>' } } }) };
  };
  const entry = autoSync.REGISTRY.find((e) => e.manualId === 'ewc-2026-t8');

  const result = await autoSync.syncOneEvent(entry);
  assert.equal(result.status, 'seeded');
  const row = await db.getAsync('SELECT * FROM tournaments WHERE name = ?', [entry.tournament.name]);
  assert.equal(row.date, '2026-08-06');
});
