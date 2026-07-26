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
  await db.runAsync(`CREATE TABLE tournaments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, date TEXT, is_live INTEGER NOT NULL DEFAULT 0, startgg_id TEXT)`);
  await db.runAsync(`CREATE TABLE set_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER, startgg_set_id TEXT,
    round_text TEXT, round_int INTEGER, phase_group_id TEXT,
    player1_id INTEGER, player2_id INTEGER, p1_seed INTEGER, p2_seed INTEGER,
    state TEXT NOT NULL DEFAULT 'open', p1_prob REAL, p2_prob REAL, seed_k_cents INTEGER DEFAULT 0,
    p1_live_odds REAL, p2_live_odds REAL,
    p1_pool_cents INTEGER NOT NULL DEFAULT 0, p2_pool_cents INTEGER NOT NULL DEFAULT 0,
    winner_id INTEGER, p1_score INTEGER NOT NULL DEFAULT 0, p2_score INTEGER NOT NULL DEFAULT 0,
    opened_at TEXT, closed_at TEXT, settled_at TEXT,
    startgg_event_id TEXT, startgg_event_name TEXT)`);
  await db.runAsync(`CREATE TABLE set_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, market_id INTEGER, picked_player_id INTEGER,
    amount_cents INTEGER, locked_odds REAL, state TEXT NOT NULL DEFAULT 'placed',
    payout_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM set_bets');
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync('DELETE FROM bracket_history');
  await db.runAsync('DELETE FROM players');
  await db.runAsync('DELETE FROM games');
  await db.runAsync('DELETE FROM tournaments');
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

test('processTournamentEvents persists which start.gg event a market came from', async () => {
  // The durable fix for the VSFighting XIV "Tekken Ball merged into the real
  // Tekken 8 bracket" bug: two different events can share a videogame, and
  // set_markets previously had no way to tell them apart after the fact.
  // Persisting the event lets db.diagnoseMultiEventGames catch ANY future
  // same-videogame merge, not just ones isSideEvent happens to name-match.
  const gameRes = await db.runAsync(`INSERT INTO games (name, startgg_id) VALUES ('TEKKEN 8', 'g-t8')`);
  const gameId = gameRes.lastID;

  const events = [{
    id: 'evt-real-t8', name: 'TEKKEN 8 (TEKKEN WORLD TOUR 2026 MASTER EVENT)',
    videogame: { id: 'g-t8', name: 'TEKKEN 8' },
    sets: {
      nodes: [{
        id: 's-real', state: 1, fullRoundText: 'Winners Semi-Final', round: 3,
        phaseGroup: { id: 'pg-real' },
        slots: [
          { entrant: { id: 'e-kanda', name: 'kanda', seeds: [{ seedNum: 1 }] }, standing: null },
        ],
      }],
    },
  }];

  await sync.processTournamentEvents({ id: 1 }, events);

  const market = await db.getAsync(`SELECT startgg_event_id, startgg_event_name FROM set_markets WHERE startgg_set_id = 's-real'`);
  assert.equal(market.startgg_event_id, 'evt-real-t8');
  assert.equal(market.startgg_event_name, 'TEKKEN 8 (TEKKEN WORLD TOUR 2026 MASTER EVENT)');
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

test('isGameFullyResolved is not tripped by a preview_* market being the only row that ever existed', async () => {
  // Reproduces a real production bug found at VSFighting XIV (26 concurrent
  // events): 13 of ~15 non-headline games never got real Top-8 markets even
  // hours after their finals started airing on stream. Each one's only
  // set_markets row was a preview_* projection that fillBracketSlot's own
  // preview cleanup (or db.js's boot sweep) voided the moment a real bracket
  // was seen elsewhere - which used to satisfy the old "has a row, nothing
  // unresolved" check and permanently mark the game fully resolved before its
  // actual finals had even started, silently stopping fetchActiveEvents /
  // fetchHistoryPhases from ever fetching that game's real bracket again.
  const gameRes = await db.runAsync(`INSERT INTO games (name, startgg_id) VALUES ('Guilty Gear: Strive', 'g-ggst')`);
  const gameId = gameRes.lastID;

  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state)
     VALUES (1, ?, 'preview_123_3_0', 'Winners Final', 1, 2, 'void')`,
    [gameId]
  );
  assert.equal(
    await sync.isGameFullyResolved(1, 'g-ggst'), false,
    'a voided preview projection is not evidence the real bracket ever ran - must keep polling'
  );

  // Once a REAL market for this game exists and settles, resolution is genuine.
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state)
     VALUES (1, ?, 'real-set-1', 'Grand Final', 1, 2, 'settled')`,
    [gameId]
  );
  assert.equal(await sync.isGameFullyResolved(1, 'g-ggst'), true);
});

test('getActiveTournaments keeps polling a tournament with genuinely unresolved sets past its date window', async () => {
  // Reproduces a real production bug found on "BR Kumite - World Warrior
  // 2026 - Brazil 3": nothing in the regular discovery pipeline ever sets
  // is_live=1 for an ordinary tournament - the date-window clause is the
  // ENTIRE activation mechanism, and it slides with "now", not with the
  // tournament's own date. Once "now" passed date+2, this tournament fell
  // out of tracking completely even though its Losers Quarter-Final was
  // still sitting 'closed' (genuinely in progress) - it sat un-polled for
  // the next day and a half.
  const gameRes = await db.runAsync(`INSERT INTO games (name, startgg_id) VALUES ('Street Fighter 6', 'g-sf6')`);
  const gameId = gameRes.lastID;

  // Dated 4 days ago - well outside the -1/+2 day window - with is_live=0,
  // exactly like an ordinary tournament the daily pipeline never flags live.
  const staleRes = await db.runAsync(
    `INSERT INTO tournaments (name, date, is_live, startgg_id) VALUES ('BR Kumite - World Warrior 2026 - Brazil 3', date('now','-4 days'), 0, 'sg-brkumite')`
  );
  const staleId = staleRes.lastID;
  // A real, still-in-progress set (Losers Quarter-Final, 'closed' = live).
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state)
     VALUES (?, ?, 'lqf-1', 'Losers Quarter-Final', 1, 2, 'closed')`,
    [staleId, gameId]
  );

  // Control: a genuinely finished tournament from the same era must NOT be
  // swept back in just for being old - only real unresolved sets do that.
  const finishedRes = await db.runAsync(
    `INSERT INTO tournaments (name, date, is_live, startgg_id) VALUES ('Finished Old Major', date('now','-10 days'), 0, 'sg-finished')`
  );
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state, winner_id)
     VALUES (?, ?, 'gf-1', 'Grand Final', 1, 2, 'settled', 1)`,
    [finishedRes.lastID, gameId]
  );

  const active = await sync.getActiveTournaments();
  const activeIds = active.map((t) => t.id);
  assert.ok(activeIds.includes(staleId), 'a tournament with a genuinely unresolved set must stay active regardless of how old its date is');
  assert.ok(!activeIds.includes(finishedRes.lastID), 'a fully-settled old tournament must not be swept back into active polling');
});

test('getActiveTournaments keeps polling a multi-day event that fell out of the date window before its real Top-8 markets ever existed', async () => {
  // Reproduces a real production bug found on "Esports World Cup 2026:
  // Street Fighter 6 - LCQ" (a 3-day event, date stores day 1 only): its
  // bracket_history showed real progress through Winners Semi-Final as of
  // this morning, but its real (non-preview) set_markets never got created
  // (Top 8 hadn't been reached when it fell out of tracking) - so the
  // BR-Kumite fix (unresolvedSetsSql checking real set_markets) couldn't
  // rescue it: there was nothing real yet to call "unresolved". Once "now"
  // moved more than a day past the stored day-1 date, it fell out of the
  // -1/+2 day window and got permanently excluded from polling mid-event,
  // stranded on stale bracket_history with no real markets ever created.
  const gameRes = await db.runAsync(`INSERT INTO games (name, startgg_id) VALUES ('Street Fighter 6', 'g-sf6-2')`);
  const gameId = gameRes.lastID;

  const lcqRes = await db.runAsync(
    `INSERT INTO tournaments (name, date, is_live, startgg_id) VALUES ('Esports World Cup 2026: Street Fighter 6 - LCQ', date('now','-2 days'), 0, 'sg-ewc-sf6-lcq')`
  );
  const lcqId = lcqRes.lastID;
  // Real bracket progress recorded recently, but no real Top-8 markets yet -
  // only a stale voided preview projection (the same shape as production).
  await db.runAsync(
    `INSERT INTO bracket_history (tournament_id, game_id, startgg_set_id, round_text, state, updated_at)
     VALUES (?, ?, 'bh-wsf-1', 'Winners Semi-Final', 'completed', datetime('now','-16 hours'))`,
    [lcqId, gameId]
  );
  await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, state) VALUES (?, ?, 'preview_1_2_0', 'void')`,
    [lcqId, gameId]
  );

  // Control: a tournament with equally-old bracket_history but no RECENT
  // activity (last touched well past STALE_PENDING_DAYS) must not be swept
  // back in - only genuinely-recent bracket progress does that.
  const oldRes = await db.runAsync(
    `INSERT INTO tournaments (name, date, is_live, startgg_id) VALUES ('Long Finished Major', date('now','-30 days'), 0, 'sg-old-major')`
  );
  await db.runAsync(
    `INSERT INTO bracket_history (tournament_id, game_id, startgg_set_id, round_text, state, updated_at)
     VALUES (?, ?, 'bh-old-1', 'Winners Semi-Final', 'completed', datetime('now','-30 days'))`,
    [oldRes.lastID, gameId]
  );

  const active = await sync.getActiveTournaments();
  const activeIds = active.map((t) => t.id);
  assert.ok(activeIds.includes(lcqId), 'a multi-day event with recent real bracket progress but no real markets yet must stay active');
  assert.ok(!activeIds.includes(oldRes.lastID), 'stale bracket_history from long ago must not sweep an old tournament back into active polling');
});
