// Futures parlay engine — money logic. Temp DB, modules required AFTER setting
// DATABASE_PATH (mirrors test/pickem/acceptance.test.js).
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let db, wallet, engine, schema, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-parlay-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  for (const m of ['../../db/db', '../../wallet', '../../parlay/engine', '../../parlay/schema']) {
    delete require.cache[require.resolve(m)];
  }
  db = require('../../db/db');
  wallet = require('../../wallet');
  engine = require('../../parlay/engine');
  schema = require('../../parlay/schema');
  await db.runAsync('CREATE TABLE users (id INTEGER PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0)');
  await db.runAsync('CREATE TABLE wallet_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount_cents INTEGER, type TEXT, ref_type TEXT, ref_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  await db.runAsync('CREATE TABLE players_games_tournaments (tournament_id INTEGER, game_id INTEGER, player_id INTEGER, live_odds REAL)');
  await schema.applyParlaySchema(db);
});

beforeEach(async () => {
  for (const t of ['parlay_legs', 'parlays', 'wallet_transactions', 'players_games_tournaments', 'users']) {
    await db.runAsync(`DELETE FROM ${t}`);
  }
  await db.runAsync('INSERT INTO users (id, balance_cents) VALUES (1, 100000)'); // 1000 FM
  // Market A (t10,g1): player100 @4, player101 @2 · Market B (t10,g2): player200 @3 · Market C (t11,g1): player300 @5
  await db.runAsync('INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, live_odds) VALUES (10,1,100,4.0),(10,1,101,2.0),(10,2,200,3.0),(11,1,300,5.0)');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

const twoLeg = [{ tournamentId: 10, gameId: 1, playerId: 100 }, { tournamentId: 10, gameId: 2, playerId: 200 }]; // @4 × @3 = 12

test('combinedOdds multiplies the legs', () => {
  assert.equal(engine.combinedOdds([4, 3]), 12);
  assert.equal(engine.combinedOdds([2, 2, 2]), 8);
  assert.equal(engine.combinedOdds([1.5, 1.5]), 2.25);
});

test('placeParlay debits the stake and stores combined odds', async () => {
  const r = await engine.placeParlay({ userId: 1, stakeCents: 1000, legs: twoLeg });
  assert.equal(r.combinedOdds, 12);
  assert.equal(r.payoutCents, 12000);
  assert.equal(await wallet.getBalance(1), 99000);
  assert.equal((await db.allAsync('SELECT * FROM parlay_legs WHERE parlay_id = ?', [r.parlayId])).length, 2);
});

test('placeParlay rejects fewer than 2 legs (no money moves)', async () => {
  await assert.rejects(
    engine.placeParlay({ userId: 1, stakeCents: 1000, legs: [twoLeg[0]] }),
    (e) => e.code === 'TOO_FEW_LEGS'
  );
  assert.equal(await wallet.getBalance(1), 100000);
});

test('placeParlay rejects two legs from the same event', async () => {
  await assert.rejects(
    engine.placeParlay({ userId: 1, stakeCents: 1000, legs: [
      { tournamentId: 10, gameId: 1, playerId: 100 },
      { tournamentId: 10, gameId: 1, playerId: 101 },
    ] }),
    (e) => e.code === 'SAME_EVENT'
  );
  assert.equal(await wallet.getBalance(1), 100000);
});

test('placeParlay rejects insufficient funds and creates no parlay', async () => {
  await assert.rejects(
    engine.placeParlay({ userId: 1, stakeCents: 200000, legs: twoLeg }),
    (e) => e.code === 'INSUFFICIENT_FUNDS'
  );
  assert.equal(await wallet.getBalance(1), 100000);
  assert.equal((await db.getAsync('SELECT COUNT(*) c FROM parlays')).c, 0);
});

test('settleMarket pays a fully-won parlay stake × combined odds', async () => {
  const r = await engine.placeParlay({ userId: 1, stakeCents: 1000, legs: twoLeg });
  await engine.settleMarket({ tournamentId: 10, gameId: 1, winnerPlayerId: 100 }); // leg 1 wins; leg 2 pending
  assert.equal((await db.getAsync('SELECT status FROM parlays WHERE id = ?', [r.parlayId])).status, 'open');
  await engine.settleMarket({ tournamentId: 10, gameId: 2, winnerPlayerId: 200 }); // leg 2 wins → all won
  const p = await db.getAsync('SELECT status, payout_cents FROM parlays WHERE id = ?', [r.parlayId]);
  assert.equal(p.status, 'won');
  assert.equal(p.payout_cents, 12000);
  assert.equal(await wallet.getBalance(1), 111000); // 99000 + 12000
});

test('settleMarket loses the parlay when any leg loses (no payout)', async () => {
  const r = await engine.placeParlay({ userId: 1, stakeCents: 1000, legs: twoLeg });
  await engine.settleMarket({ tournamentId: 10, gameId: 1, winnerPlayerId: 101 }); // leg 1 LOST
  await engine.settleMarket({ tournamentId: 10, gameId: 2, winnerPlayerId: 200 }); // leg 2 won
  const p = await db.getAsync('SELECT status, payout_cents FROM parlays WHERE id = ?', [r.parlayId]);
  assert.equal(p.status, 'lost');
  assert.equal(p.payout_cents, 0);
  assert.equal(await wallet.getBalance(1), 99000); // stake stays gone, nothing credited
});

test('voidMarket refunds the full stake', async () => {
  const r = await engine.placeParlay({ userId: 1, stakeCents: 1000, legs: twoLeg });
  assert.equal(await wallet.getBalance(1), 99000);
  await engine.voidMarket({ tournamentId: 10, gameId: 1 });
  assert.equal((await db.getAsync('SELECT status FROM parlays WHERE id = ?', [r.parlayId])).status, 'void');
  assert.equal(await wallet.getBalance(1), 100000);
});
