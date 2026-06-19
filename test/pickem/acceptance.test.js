// Pick'em acceptance suite (spec §8). DB-backed cases 1,2,3,5,8,9,10,11,12.
// (Pure-math cases 4,6,7 live in scoring.test.js.)
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let db, engine, file;
const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

before(async () => {
  file = path.join(os.tmpdir(), `mm-pickem-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  delete require.cache[require.resolve('../../pickem/engine')];
  db = require('../../db/db');
  const { applyPickemSchema } = require('../../pickem/schema');
  engine = require('../../pickem/engine');
  // Minimal base tables (the columns the engine reads); applyPickemSchema extends them.
  await db.runAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT)`);
  await db.runAsync(`CREATE TABLE set_markets (
    id INTEGER PRIMARY KEY, tournament_id INTEGER, game_id INTEGER,
    player1_id INTEGER, player2_id INTEGER, state TEXT DEFAULT 'open', winner_id INTEGER)`);
  await applyPickemSchema(db);
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

beforeEach(async () => {
  for (const t of ['pickem_picks', 'coin_ledger', 'leaderboard_entries', 'seasons', 'set_markets', 'users']) {
    await db.runAsync(`DELETE FROM ${t}`);
  }
  for (let i = 1; i <= 6; i++) {
    await db.runAsync('INSERT INTO users (id, username, email, password) VALUES (?,?,?,?)',
      [i, `u${i}`, `u${i}@x.com`, 'h']);
  }
});

async function seedMarket({ id, p1 = 1, p2 = 2, round = 'top8', state = 'open', locksAt = null, gameId = 1, tournamentId = 1 }) {
  await db.runAsync(
    'INSERT INTO set_markets (id, tournament_id, game_id, player1_id, player2_id, state, round, locks_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, tournamentId, gameId, p1, p2, state, round, locksAt]
  );
}

// --- Case 1 ---
test('1: pick stored, edit updates, UNIQUE prevents a true second pick', async () => {
  await seedMarket({ id: 10, p1: 1, p2: 2, locksAt: FUTURE });
  const r1 = await engine.placePick({ userId: 1, marketId: 10, pickedPlayerId: 1 });
  assert.equal(r1.created, true);
  assert.equal((await db.getAsync('SELECT picked_player_id AS p FROM pickem_picks WHERE user_id=1 AND market_id=10')).p, 1);

  const r2 = await engine.placePick({ userId: 1, marketId: 10, pickedPlayerId: 2 });
  assert.equal(r2.created, false); // edit
  assert.equal((await db.getAsync('SELECT picked_player_id AS p FROM pickem_picks WHERE user_id=1 AND market_id=10')).p, 2);
  assert.equal((await db.getAsync('SELECT COUNT(*) AS n FROM pickem_picks WHERE user_id=1 AND market_id=10')).n, 1);

  await assert.rejects(db.runAsync('INSERT INTO pickem_picks (user_id, market_id, picked_player_id) VALUES (1,10,1)'));
});

// --- Case 2 ---
test('2: pick at/after locks_at rejected; market reads locked', async () => {
  await seedMarket({ id: 11, locksAt: PAST });
  assert.equal(engine.isLocked(await engine.getMarket(11)), true);
  await assert.rejects(engine.placePick({ userId: 1, marketId: 11, pickedPlayerId: 1 }), /locked/);

  await seedMarket({ id: 12, locksAt: FUTURE });
  const afterLock = Date.parse(FUTURE) + 1000;
  assert.equal(engine.isLocked(await engine.getMarket(12), afterLock), true);
  await assert.rejects(engine.placePick({ userId: 1, marketId: 12, pickedPlayerId: 1 }, afterLock), /locked/);
});

// --- Case 3 ---
test('3: live split is count-weighted; lock snapshot equals the live value', async () => {
  await seedMarket({ id: 13, p1: 1, p2: 2, round: 'top8', locksAt: FUTURE });
  await engine.placePick({ userId: 1, marketId: 13, pickedPlayerId: 1 });
  await engine.placePick({ userId: 2, marketId: 13, pickedPlayerId: 1 });
  await engine.placePick({ userId: 3, marketId: 13, pickedPlayerId: 2 });

  const live = await engine.liveSplit(13);
  assert.equal(live.total, 3);
  assert.ok(Math.abs(live.split[1] - 2 / 3) < 1e-9);
  assert.ok(Math.abs(live.split[2] - 1 / 3) < 1e-9);

  await engine.lockMarket(13);
  const m = await engine.getMarket(13);
  const snap = JSON.parse(m.community_split);
  assert.ok(Math.abs(snap['1'] - 2 / 3) < 1e-9);
  assert.ok(Math.abs(snap['2'] - 1 / 3) < 1e-9);
  assert.equal(m.round_multiplier, 1.75);
});

// --- Case 5 ---
test('5: correct -> ledger+balance+leaderboard scopes; incorrect -> 0 + streak reset', async () => {
  await seedMarket({ id: 20, p1: 1, p2: 2, round: 'top8', gameId: 7, tournamentId: 3, locksAt: FUTURE });
  await engine.placePick({ userId: 1, marketId: 20, pickedPlayerId: 1 });
  await engine.placePick({ userId: 2, marketId: 20, pickedPlayerId: 2 });
  await engine.lockMarket(20); // 50/50 split
  await engine.settleMarket(20, 1, '2026-01-01T00:00:00Z'); // winner p1 -> u1 correct

  const pk1 = await db.getAsync('SELECT * FROM pickem_picks WHERE user_id=1 AND market_id=20');
  assert.equal(pk1.result, 'correct');
  assert.equal(pk1.points_awarded, 350); // 100 * 1.75 * 2.0
  assert.equal(pk1.coins_awarded, 175);
  assert.equal(await engine.getCoinBalance(1), 175);
  assert.equal((await db.getAsync("SELECT delta FROM coin_ledger WHERE user_id=1 AND reason='pick_reward'")).delta, 175);
  for (const [scope, ref] of [['global', ''], ['game', '7'], ['event', '3']]) {
    const e = await engine.getLeaderboardEntry(1, scope, ref);
    assert.equal(e.points, 350, `${scope} points`);
    assert.equal(e.correct_count, 1);
    assert.equal(e.total_picks, 1);
    assert.equal(e.current_streak, 1);
  }

  const pk2 = await db.getAsync('SELECT * FROM pickem_picks WHERE user_id=2 AND market_id=20');
  assert.equal(pk2.result, 'incorrect');
  assert.equal(pk2.points_awarded, 0);
  assert.equal(await engine.getCoinBalance(2), 0);
  const g2 = await engine.getLeaderboardEntry(2, 'global', '');
  assert.equal(g2.points, 0);
  assert.equal(g2.current_streak, 0);
});

// --- Case 8 ---
test('8: re-settling a market does not double-credit', async () => {
  await seedMarket({ id: 30, p1: 1, p2: 2, round: 'gf', locksAt: FUTURE });
  await engine.placePick({ userId: 1, marketId: 30, pickedPlayerId: 1 });
  await engine.lockMarket(30);
  await engine.settleMarket(30, 1, '2026-01-01T00:00:00Z');

  const bal = await engine.getCoinBalance(1);
  const pts = (await engine.getLeaderboardEntry(1, 'global', '')).points;
  const r = await engine.settleMarket(30, 1, '2026-01-02T00:00:00Z');
  assert.equal(r.alreadyScored, true);
  assert.equal(await engine.getCoinBalance(1), bal);
  assert.equal((await engine.getLeaderboardEntry(1, 'global', '')).points, pts);
  assert.equal((await db.getAsync('SELECT COUNT(*) AS n FROM coin_ledger WHERE user_id=1')).n, 1);
});

// --- Case 9 ---
test('9: streak increments, milestone bonus fires once, incorrect resets', async () => {
  for (let i = 1; i <= 5; i++) {
    await seedMarket({ id: 40 + i, p1: 1, p2: 2, round: 'r1', locksAt: FUTURE });
    await engine.placePick({ userId: 1, marketId: 40 + i, pickedPlayerId: 1 });
    await engine.lockMarket(40 + i);
    await engine.settleMarket(40 + i, 1, '2026-01-01T00:00:00Z');
    assert.equal((await engine.getLeaderboardEntry(1, 'global', '')).current_streak, i);
  }
  const bonus = await db.allAsync("SELECT * FROM coin_ledger WHERE user_id=1 AND reason='streak_bonus'");
  assert.equal(bonus.length, 1);
  assert.equal(bonus[0].delta, 50); // milestone 5

  await seedMarket({ id: 47, p1: 1, p2: 2, round: 'r1', locksAt: FUTURE });
  await engine.placePick({ userId: 1, marketId: 47, pickedPlayerId: 2 });
  await engine.lockMarket(47);
  await engine.settleMarket(47, 1, '2026-01-01T00:00:00Z'); // p1 wins, u1 picked p2 -> wrong
  const g = await engine.getLeaderboardEntry(1, 'global', '');
  assert.equal(g.current_streak, 0);
  assert.equal(g.best_streak, 5);
});

// --- Case 10 ---
test('10: coins never sourced from real money; no cash-out path', async () => {
  for (const name of Object.keys(engine)) {
    assert.ok(!/buy|purchase|deposit|cashout|cash_out|withdraw|redeem/i.test(name), `unexpected monetary fn: ${name}`);
  }
  await seedMarket({ id: 50, p1: 1, p2: 2, round: 'top8', locksAt: FUTURE });
  await engine.placePick({ userId: 1, marketId: 50, pickedPlayerId: 1 });
  await engine.lockMarket(50);
  await engine.settleMarket(50, 1, '2026-01-01T00:00:00Z');

  const allowed = new Set(['pick_reward', 'streak_bonus', 'daily_login', 'seasonal_reset']);
  for (const { reason } of await db.allAsync('SELECT DISTINCT reason FROM coin_ledger')) {
    assert.ok(allowed.has(reason), `non-allowed ledger reason: ${reason}`);
  }
  assert.equal((await db.getAsync('SELECT COUNT(*) AS n FROM coin_ledger WHERE delta < 0')).n, 0);
});

// --- Case 11 ---
test('11: a pick on any match is accepted (no age/eligibility gate on the free layer)', async () => {
  await seedMarket({ id: 60, p1: 1, p2: 2, round: 'r1', locksAt: FUTURE });
  const r = await engine.placePick({ userId: 1, marketId: 60, pickedPlayerId: 1 });
  assert.equal(r.created, true);
});

// --- Case 12 ---
test('12: season-scoped points; new season resets season scope, global persists', async () => {
  await db.runAsync("INSERT INTO seasons (id, name, circuit, starts_at, ends_at) VALUES (1,'A','mixed','2026-01-01T00:00:00Z','2026-06-30T23:59:59Z')");
  await db.runAsync("INSERT INTO seasons (id, name, circuit, starts_at, ends_at) VALUES (2,'B','mixed','2026-07-01T00:00:00Z','2026-12-31T23:59:59Z')");

  await seedMarket({ id: 70, p1: 1, p2: 2, round: 'top8', locksAt: FUTURE });
  await engine.placePick({ userId: 1, marketId: 70, pickedPlayerId: 1 });
  await engine.lockMarket(70);
  await engine.settleMarket(70, 1, '2026-03-01T00:00:00Z'); // season A, solo pick -> 175

  await seedMarket({ id: 71, p1: 1, p2: 2, round: 'top8', locksAt: FUTURE });
  await engine.placePick({ userId: 1, marketId: 71, pickedPlayerId: 1 });
  await engine.lockMarket(71);
  await engine.settleMarket(71, 1, '2026-09-01T00:00:00Z'); // season B -> 175

  assert.equal((await engine.getLeaderboardEntry(1, 'global', '')).points, 350); // persists
  assert.equal((await engine.getLeaderboardEntry(1, 'season', '1')).points, 175);
  assert.equal((await engine.getLeaderboardEntry(1, 'season', '2')).points, 175); // fresh
});
