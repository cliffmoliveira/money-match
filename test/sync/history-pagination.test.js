const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Reproduces a real production bug found at CEO 2026: Marvel Tokon: Fighting
// Souls' Round 1 pools alone had 1,860 real sets on start.gg (a huge field
// for a breakout-popularity game) - fetchHistoryPhaseSets's old pagination
// ceiling (MAX_HISTORY_SET_PAGES=40, HISTORY_SET_PAGE_SIZE=15 -> 600 sets)
// silently truncated after page 40, so roughly 1,260 of that round's real,
// decided results never made it into bracket_history at all, with no error
// or log line marking the gap - confirmed live via a direct count against
// start.gg (1,852 real completed sets vs 687 actually synced).
let db, sync, startggClient, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-history-pg-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  for (const m of ['../../db/db', '../../liveMarkets', '../../startggClient', '../../scripts/sync-live']) {
    delete require.cache[require.resolve(m)];
  }
  db = require('../../db/db');
  // Patch startgg BEFORE requiring sync-live.js, which destructures it at
  // require time - mutating the export afterward wouldn't reach sync-live's
  // already-bound local reference.
  startggClient = require('../../startggClient');
  await db.runAsync(`CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, startgg_id TEXT)`);
  await db.runAsync(`CREATE TABLE tournaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, date TEXT, is_live INTEGER NOT NULL DEFAULT 0, startgg_id TEXT)`);
  await db.runAsync(`CREATE TABLE set_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER, startgg_set_id TEXT,
    state TEXT NOT NULL DEFAULT 'open')`);
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

test('fetchHistoryPhaseSets pages through a pools round far larger than the old 600-set cap', async (t) => {
  // ggRetry sleeps 600ms (rate-limit pacing) before every real request - fake
  // the clock so exercising 124 real pages of the real pagination loop takes
  // milliseconds instead of ~75s.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const TOTAL_SETS = 1860; // Marvel Tokon's real Round 1 count at CEO 2026
  const pageLog = [];
  startggClient.startgg = async (query, vars) => {
    pageLog.push(vars.page);
    const { page, perPage } = vars;
    const totalPages = Math.ceil(TOTAL_SETS / perPage);
    const startIdx = (page - 1) * perPage;
    const count = Math.max(0, Math.min(perPage, TOTAL_SETS - startIdx));
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: startIdx + i + 1, state: 3, fullRoundText: 'Round 1', winnerId: 1, round: 1,
      phaseGroup: { id: `g${(startIdx + i) % 10}` }, slots: [],
    }));
    return { event: { id: vars.eventId, sets: { pageInfo: { totalPages }, nodes } } };
  };
  delete require.cache[require.resolve('../../scripts/sync-live')];
  sync = require('../../scripts/sync-live');

  const events = [{
    id: 1517807,
    name: 'MARVEL Tokon: Fighting Souls',
    videogame: { id: 999999, name: 'Marvel Tokon: Fighting Souls' },
    phases: [
      { id: 1, name: 'Round 1', phaseOrder: 1 },
      { id: 2, name: 'Top 8', phaseOrder: 2 },
    ],
  }];

  let history = null;
  const historyPromise = sync.fetchHistoryPhases('sg-ceo-2026', events, /* tournamentId */ 1).then((h) => { history = h; });
  // Each page fetch does `await sleep(600ms)` before its request, then awaits
  // the (mocked, but still async) request itself - multiple microtask hops
  // per page. Interleave clock ticks with real task-queue flushes (not just
  // microtasks) until the promise actually settles, covering all 124
  // expected pages (1860 sets / 15 per page) plus headroom.
  for (let i = 0; i < 300 && history === null; i++) {
    t.mock.timers.tick(600);
    await new Promise((r) => setImmediate(r));
  }
  await historyPromise;
  assert.ok(history, 'fetchHistoryPhases never settled within the simulated clock budget');
  assert.equal(history.length, 1, 'only the non-final Round 1 phase gets history-fetched');
  assert.equal(history[0].sets.length, TOTAL_SETS, 'every real set across all pages made it through, not just the first 600');
  assert.ok(pageLog.length > 40, `expected more than the old 40-page cap, got ${pageLog.length} pages`);
});

test('ggRetry recovers a single transient network timeout mid-pagination instead of discarding everything fetched so far', async (t) => {
  // Reproduces a real production failure: manually re-running the backfill
  // for CEO 2026's Marvel Tokon: Fighting Souls twice in a row, each attempt
  // hit exactly one axios timeout (no HTTP response at all, so status is
  // undefined) partway through the ~124-page Round 1 fetch - ggRetry only
  // ever retried on a real 429 response, so a single transient hiccup threw
  // away every page already fetched and aborted the whole tournament sync.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const TOTAL_SETS = 45; // 3 pages at perPage 15
  let calls = 0;
  startggClient.startgg = async (query, vars) => {
    calls++;
    // Fail the SECOND request only (page 2) with a bare axios-style timeout
    // (no `response` object) - everything else succeeds normally.
    if (calls === 2) {
      const err = new Error('timeout of 10000ms exceeded');
      err.code = 'ECONNABORTED';
      throw err;
    }
    const { page, perPage } = vars;
    const totalPages = Math.ceil(TOTAL_SETS / perPage);
    const startIdx = (page - 1) * perPage;
    const count = Math.max(0, Math.min(perPage, TOTAL_SETS - startIdx));
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: startIdx + i + 1, state: 3, fullRoundText: 'Round 1', winnerId: 1, round: 1,
      phaseGroup: { id: 'g1' }, slots: [],
    }));
    return { event: { id: vars.eventId, sets: { pageInfo: { totalPages }, nodes } } };
  };
  delete require.cache[require.resolve('../../scripts/sync-live')];
  sync = require('../../scripts/sync-live');

  const events = [{
    id: 1517807,
    name: 'MARVEL Tokon: Fighting Souls',
    videogame: { id: 999999, name: 'Marvel Tokon: Fighting Souls' },
    phases: [
      { id: 1, name: 'Round 1', phaseOrder: 1 },
      { id: 2, name: 'Top 8', phaseOrder: 2 },
    ],
  }];

  let history = null;
  let historyErr = null;
  const historyPromise = sync.fetchHistoryPhases('sg-ceo-2026', events, 1)
    .then((h) => { history = h; })
    .catch((e) => { historyErr = e; });
  for (let i = 0; i < 50 && history === null && historyErr === null; i++) {
    t.mock.timers.tick(10000);
    await new Promise((r) => setImmediate(r));
  }
  await historyPromise;
  assert.equal(historyErr, null, `fetchHistoryPhases should recover from the transient timeout, not throw: ${historyErr}`);
  assert.ok(history, 'fetchHistoryPhases never settled within the simulated clock budget');
  assert.equal(history[0].sets.length, TOTAL_SETS, 'all 3 pages made it through despite page 2 timing out once');
});
