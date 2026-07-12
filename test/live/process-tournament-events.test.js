const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Reproduces a real production bug found on the EWC 2026 FATAL FURY LCQ:
// a market created earlier (while only one entrant was known) never got its
// second slot backfilled once start.gg reported the set complete - the
// "existing market" branch in processTournamentEvents settled directly
// without ever calling fillBracketSlot for the newly-known slot. Combined
// with settleMarket's TBD guard (liveMarkets.js), the market was stuck
// permanently 'pending' with one side still the TBD sentinel, showing
// "WAITING" in the bracket forever even after the whole tournament finished.
let db, lm, sync, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-pte-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  for (const m of ['../../db/db', '../../txn', '../../wallet', '../../economy', '../../liveOdds', '../../liveMarkets', '../../startggClient', '../../scripts/sync-live']) {
    delete require.cache[require.resolve(m)];
  }
  db = require('../../db/db');
  lm = require('../../liveMarkets');
  sync = require('../../scripts/sync-live');

  await db.runAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0)`);
  await db.runAsync(`CREATE TABLE wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount_cents INTEGER, type TEXT,
    ref_type TEXT, ref_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
  await db.runAsync(`CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, country TEXT, startgg_id TEXT, photo_url TEXT)`);
  await db.runAsync(`CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, startgg_id TEXT)`);
  await db.runAsync(`CREATE TABLE set_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER, startgg_set_id TEXT,
    round_text TEXT, round_int INTEGER, phase_group_id TEXT,
    player1_id INTEGER, player2_id INTEGER, p1_seed INTEGER, p2_seed INTEGER,
    state TEXT NOT NULL DEFAULT 'open', p1_prob REAL, p2_prob REAL, seed_k_cents INTEGER DEFAULT 0,
    p1_live_odds REAL, p2_live_odds REAL,
    p1_pool_cents INTEGER NOT NULL DEFAULT 0, p2_pool_cents INTEGER NOT NULL DEFAULT 0,
    winner_id INTEGER, p1_score INTEGER NOT NULL DEFAULT 0, p2_score INTEGER NOT NULL DEFAULT 0,
    opened_at TEXT, closed_at TEXT, settled_at TEXT)`);
  await db.runAsync(`CREATE TABLE set_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, market_id INTEGER, picked_player_id INTEGER,
    amount_cents INTEGER, locked_odds REAL, state TEXT NOT NULL DEFAULT 'placed',
    payout_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM set_bets');
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync('DELETE FROM players');
  await db.runAsync('DELETE FROM games');
  await db.runAsync('DELETE FROM wallet_transactions');
  await db.runAsync('DELETE FROM users');
  lm.invalidateBankrollCache();
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

test('processTournamentEvents backfills a still-TBD slot on a pre-existing market once start.gg reports the set complete', async () => {
  const gameRes = await db.runAsync(`INSERT INTO games (name, startgg_id) VALUES ('FATAL FURY: City of the Wolves', 'g1')`);
  const gameId = gameRes.lastID;
  const pidaRes = await db.runAsync(`INSERT INTO players (name, startgg_id) VALUES ('Pida', 'e-pida')`);
  const pidaId = pidaRes.lastID;

  // The market was created earlier when only Pida's slot was known (e.g. via
  // the state===1 pending-fill path) - player2 is still the TBD sentinel.
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state)
     VALUES (1, ?, 's-semi', 'Losers Semi-Final', ?, 0, 'pending')`,
    [gameId, pidaId]
  );

  const events = [{
    videogame: { id: 'g1', name: 'FATAL FURY: City of the Wolves' },
    sets: {
      nodes: [{
        id: 's-semi', state: 3, fullRoundText: 'Losers Semi-Final', round: 4, winnerId: 'e-xiaocai',
        phaseGroup: { id: 'pg1' },
        slots: [
          { entrant: { id: 'e-pida', name: 'Pida', seeds: [{ seedNum: 6 }] }, standing: { stats: { score: { value: 0 } } } },
          { entrant: { id: 'e-xiaocai', name: 'WBG | XiaoCai', seeds: [{ seedNum: 14 }] }, standing: { stats: { score: { value: 3 } } } },
        ],
      }],
    },
  }];

  const stats = await sync.processTournamentEvents({ id: 1 }, events);
  assert.equal(stats.settled, 1);

  const market = await db.getAsync(`SELECT * FROM set_markets WHERE startgg_set_id = 's-semi'`);
  assert.equal(market.state, 'settled');
  assert.notEqual(market.player2_id, 0, 'XiaoCai must be backfilled into the TBD slot, not left as the sentinel');
  const xiaocai = await db.getAsync(`SELECT id FROM players WHERE startgg_id = 'e-xiaocai'`);
  assert.equal(market.player2_id, xiaocai.id);
  assert.equal(market.winner_id, xiaocai.id);
  assert.equal(market.p1_score, 0);
  assert.equal(market.p2_score, 3);
});

test('processTournamentEvents settles a just-finished match before advancing its winner into a downstream pending slot, even when start.gg lists the pending set first', async () => {
  // Reproduces a real production race on Saltmine League - UK & Ireland 3:
  // Losers Final just finished (EndingWalker beat MysticSmash) and Grand
  // Final already shows both real entrants (EndingWalker advanced) in the
  // SAME poll batch. fillBracketSlot's stillActive guard blocks filling a
  // player into a downstream slot while they still show 'open'/'closed'
  // elsewhere - if the still-pending Grand Final is processed before the
  // Losers Final gets settled, our own not-yet-updated 'closed' state on
  // EndingWalker's Losers Final row makes stillActive block the advance,
  // leaving Grand Final stuck on TBD for a whole extra poll cycle.
  const gameRes = await db.runAsync(`INSERT INTO games (name, startgg_id) VALUES ('Street Fighter 6', 'g1')`);
  const gameId = gameRes.lastID;
  const problemXRes = await db.runAsync(`INSERT INTO players (name, startgg_id) VALUES ('Problem X', 'e-problemx')`);
  const problemXId = problemXRes.lastID;
  const mysticSmashRes = await db.runAsync(`INSERT INTO players (name, startgg_id) VALUES ('MysticSmash', 'e-mysticsmash')`);
  const mysticSmashId = mysticSmashRes.lastID;
  const endingWalkerRes = await db.runAsync(`INSERT INTO players (name, startgg_id) VALUES ('EndingWalker', 'e-endingwalker')`);
  const endingWalkerId = endingWalkerRes.lastID;

  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state)
     VALUES (1, ?, 'losers-final', 'Losers Final', ?, ?, 'closed')`,
    [gameId, mysticSmashId, endingWalkerId]
  );
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state)
     VALUES (1, ?, 'grand-final', 'Grand Final', ?, 0, 'pending')`,
    [gameId, problemXId]
  );

  const events = [{
    videogame: { id: 'g1', name: 'Street Fighter 6' },
    sets: {
      // Grand Final (still pending) listed BEFORE Losers Final (now complete) -
      // the exact ordering that exposes the race without the fix.
      nodes: [
        {
          id: 'grand-final', state: 1, fullRoundText: 'Grand Final', round: null,
          slots: [
            { entrant: { id: 'e-problemx', name: 'Problem X', seeds: [{ seedNum: 1 }] } },
            { entrant: { id: 'e-endingwalker', name: 'EndingWalker', seeds: [{ seedNum: 3 }] } },
          ],
        },
        {
          id: 'losers-final', state: 3, fullRoundText: 'Losers Final', round: null, winnerId: 'e-endingwalker',
          slots: [
            { entrant: { id: 'e-mysticsmash', name: 'MysticSmash', seeds: [{ seedNum: 2 }] }, standing: { stats: { score: { value: 0 } } } },
            { entrant: { id: 'e-endingwalker', name: 'EndingWalker', seeds: [{ seedNum: 3 }] }, standing: { stats: { score: { value: 3 } } } },
          ],
        },
      ],
    },
  }];

  await sync.processTournamentEvents({ id: 1 }, events);

  const losersFinal = await db.getAsync(`SELECT * FROM set_markets WHERE startgg_set_id = 'losers-final'`);
  assert.equal(losersFinal.state, 'settled');
  assert.equal(losersFinal.winner_id, endingWalkerId);

  const grandFinal = await db.getAsync(`SELECT * FROM set_markets WHERE startgg_set_id = 'grand-final'`);
  assert.equal(grandFinal.player2_id, endingWalkerId, 'EndingWalker must advance into Grand Final in the same cycle their Losers Final settles');
});

test('processTournamentEvents backfills a still-TBD slot on a pre-existing pending market once start.gg reports the set in progress (state 2)', async () => {
  // Reproduces a real production bug found on "Only The Best 2026"'s TEKKEN 8
  // bracket: Losers Final was created earlier as 'pending' with only Meo-IL's
  // slot known (the state===1 path, waiting on the Losers Semi-Final feeder).
  // Once Sin won that feeder and Start.gg moved Losers Final to state 2 (in
  // progress, both entrants now real), the state===2 "existing market"
  // branch called closeMarket directly without ever re-filling the TBD slot.
  // closeMarket only transitions 'open'/'closed' rows, so it silently
  // no-op'd on the still-'pending' row, leaving Sin's slot stuck on the TBD
  // sentinel and the bracket showing "WAITING ... TBD" even while the real
  // match was actively being played.
  const gameRes = await db.runAsync(`INSERT INTO games (name, startgg_id) VALUES ('TEKKEN 8', 'g1')`);
  const gameId = gameRes.lastID;
  const meoIlRes = await db.runAsync(`INSERT INTO players (name, startgg_id) VALUES ('NIP | Meo-IL', 'e-meoil')`);
  const meoIlId = meoIlRes.lastID;

  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state)
     VALUES (1, ?, 'losers-final', 'Losers Final', ?, 0, 'pending')`,
    [gameId, meoIlId]
  );

  const events = [{
    videogame: { id: 'g1', name: 'TEKKEN 8' },
    sets: {
      nodes: [{
        id: 'losers-final', state: 2, fullRoundText: 'Losers Final', round: 5,
        slots: [
          { entrant: { id: 'e-meoil', name: 'NIP | Meo-IL', seeds: [{ seedNum: 3 }] }, standing: { stats: { score: { value: 0 } } } },
          { entrant: { id: 'e-sin', name: 'FOX | Sin', seeds: [{ seedNum: 4 }] }, standing: { stats: { score: { value: 0 } } } },
        ],
      }],
    },
  }];

  const stats = await sync.processTournamentEvents({ id: 1 }, events);
  assert.equal(stats.closed, 1);

  const market = await db.getAsync(`SELECT * FROM set_markets WHERE startgg_set_id = 'losers-final'`);
  assert.equal(market.state, 'closed');
  assert.notEqual(market.player2_id, 0, 'Sin must be backfilled into the TBD slot, not left as the sentinel');
  const sin = await db.getAsync(`SELECT id FROM players WHERE startgg_id = 'e-sin'`);
  assert.equal(market.player2_id, sin.id);
});

test('isGameFullyResolved skips a game once every set is settled, but not while any are still open/closed/pending', async () => {
  // A big multi-game major re-fetching every event's phases on every 60s
  // cycle is enough call volume on its own to blow through Start.gg's rate
  // limit - confirmed live on "Only The Best 2026" (20+ events), where a
  // Melty Blood Grand Final sat stuck 'open' for ~6 hours despite a healthy
  // poller, while unrelated games in the same tournament had long since
  // settled and had nothing left to say. Games with nothing left unresolved
  // should be skippable so the rate-limit budget goes to what's still live.
  const gameRes = await db.runAsync(`INSERT INTO games (name, startgg_id) VALUES ('Street Fighter 6', 'g-sf6')`);
  const gameId = gameRes.lastID;

  // Never synced at all - no rows yet - must not be treated as "resolved".
  assert.equal(await sync.isGameFullyResolved(1, 'g-sf6'), false);

  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state)
     VALUES (1, ?, 's1', 'Grand Final', 1, 2, 'open')`,
    [gameId]
  );
  assert.equal(await sync.isGameFullyResolved(1, 'g-sf6'), false, 'an open set means still bettable, not resolved');

  await db.runAsync(`UPDATE set_markets SET state='settled' WHERE startgg_set_id='s1'`);
  assert.equal(await sync.isGameFullyResolved(1, 'g-sf6'), true, 'every set settled means nothing left that could change');

  // A different tournament tracking the same videogame must not be affected
  // by tournament 1's resolved state.
  assert.equal(await sync.isGameFullyResolved(2, 'g-sf6'), false);
});
