const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Exercise the live-betting money path (placeBet/settleMarket) against a fresh
// temp DB. Wire DATABASE_PATH before requiring so the shared connection, txn
// mutex, wallet, economy, and liveMarkets all bind to the test DB.
let db, lm, wallet, file;

const P1 = 101, P2 = 102;
const START = 1_000_000; // 10,000 FM — far above the 10% bet cap for the stakes used

before(async () => {
  file = path.join(os.tmpdir(), `mm-money-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  for (const m of ['../../db/db', '../../txn', '../../wallet', '../../economy', '../../liveOdds', '../../liveMarkets']) {
    delete require.cache[require.resolve(m)];
  }
  db = require('../../db/db');
  wallet = require('../../wallet');
  lm = require('../../liveMarkets');

  await db.runAsync(`CREATE TABLE users (id INTEGER PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0)`);
  await db.runAsync(`CREATE TABLE wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount_cents INTEGER, type TEXT,
    ref_type TEXT, ref_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
  await db.runAsync(`CREATE TABLE set_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER, startgg_set_id TEXT,
    round_text TEXT, round_int INTEGER, phase_group_id TEXT,
    player1_id INTEGER, player2_id INTEGER, p1_seed INTEGER, p2_seed INTEGER,
    state TEXT NOT NULL DEFAULT 'open', p1_prob REAL, p2_prob REAL, seed_k_cents INTEGER DEFAULT 0,
    p1_live_odds REAL, p2_live_odds REAL,
    p1_pool_cents INTEGER NOT NULL DEFAULT 0, p2_pool_cents INTEGER NOT NULL DEFAULT 0,
    winner_id INTEGER, p1_score INTEGER, p2_score INTEGER,
    opened_at TEXT, closed_at TEXT, settled_at TEXT)`);
  await db.runAsync(`CREATE TABLE set_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, market_id INTEGER, picked_player_id INTEGER,
    amount_cents INTEGER, locked_odds REAL, state TEXT NOT NULL DEFAULT 'placed',
    payout_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM set_bets');
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync('DELETE FROM wallet_transactions');
  await db.runAsync('DELETE FROM users');
  lm.invalidateBankrollCache();
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

async function addUser(id) {
  await db.runAsync('INSERT INTO users (id, balance_cents) VALUES (?, ?)', [id, START]);
}
async function openMarket() {
  const r = await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, player1_id, player2_id,
       state, p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
     VALUES (1, 1, 'm-1', ?, ?, 'open', 0.5, 0.5, 0, 1.9, 1.9)`,
    [P1, P2]
  );
  return r.lastID;
}
const ledgerSum = async (userId) =>
  (await db.getAsync('SELECT COALESCE(SUM(amount_cents),0) AS s FROM wallet_transactions WHERE user_id = ?', [userId])).s;
const balance = async (userId) => (await db.getAsync('SELECT balance_cents AS b FROM users WHERE id = ?', [userId])).b;

// Core invariant: every user's balance equals their starting grant plus the sum
// of their ledger entries (no money created or lost outside the ledger).
async function assertLedgerReconciles(userIds) {
  for (const u of userIds) {
    assert.equal(await balance(u), START + (await ledgerSum(u)), `user ${u} balance must equal start + ledger`);
  }
}

test('happy path: stakes debited, winners paid, ledger reconciles', async () => {
  const users = [1, 2, 3, 4];
  for (const u of users) await addUser(u);
  const marketId = await openMarket();

  // 1,2 back P1 (the winner); 3,4 back P2.
  for (const u of [1, 2]) await lm.placeBet({ userId: u, marketId, playerId: P1, amountCents: 1000 });
  for (const u of [3, 4]) await lm.placeBet({ userId: u, marketId, playerId: P2, amountCents: 1000 });

  await lm.settleMarket(marketId, P1, 2, 0);

  await assertLedgerReconciles(users);
  // No bet left dangling in 'placed'.
  const stuck = await db.getAsync(`SELECT COUNT(*) AS c FROM set_bets WHERE market_id = ? AND state = 'placed'`, [marketId]);
  assert.equal(stuck.c, 0);
  // Winners are 'won' with a matching bet_payout credit; losers are 'lost', paid 0.
  const won = await db.allAsync(`SELECT * FROM set_bets WHERE state = 'won'`);
  assert.equal(won.length, 2);
  for (const bet of won) {
    const credit = await db.getAsync(
      `SELECT amount_cents FROM wallet_transactions WHERE type = 'bet_payout' AND ref_id = ?`, [bet.id]);
    assert.equal(credit.amount_cents, bet.payout_cents);
    assert.ok(bet.payout_cents > 0);
  }
});

test('concurrency: a burst of bets while the market settles never loses money', async () => {
  const users = Array.from({ length: 12 }, (_, i) => i + 1);
  for (const u of users) await addUser(u);
  const marketId = await openMarket();

  // Fire all placements AND the settlement together. The global write mutex must
  // serialize them so no bet is debited-but-never-settled, regardless of where
  // the settle lands in the order.
  const ops = [];
  users.forEach((u, i) => {
    ops.push(lm.placeBet({ userId: u, marketId, playerId: i % 2 === 0 ? P1 : P2, amountCents: 1000 }));
    if (i === 5) ops.push(lm.settleMarket(marketId, P1, 2, 1)); // settle mid-burst
  });
  const results = await Promise.allSettled(ops);

  const placed = results.filter((r, idx) => idx !== 6); // index 6 is the settle
  const accepted = placed.filter((r) => r.status === 'fulfilled').length;
  const rejected = placed.filter((r) => r.status === 'rejected');
  // Every rejection must be a clean MARKET_CLOSED (bet arrived after settle), not a crash.
  for (const r of rejected) assert.equal(r.reason.code, 'MARKET_CLOSED');

  // Exactly one bet row per accepted placement — rolled-back ones leave nothing.
  const betCount = (await db.getAsync('SELECT COUNT(*) AS c FROM set_bets')).c;
  assert.equal(betCount, accepted);
  // No bet is debited without being recorded: one bet_stake debit per bet row.
  const stakeDebits = (await db.getAsync(`SELECT COUNT(*) AS c FROM wallet_transactions WHERE type = 'bet_stake'`)).c;
  assert.equal(stakeDebits, betCount);
  // No bet stuck in 'placed' after settlement.
  const stuck = (await db.getAsync(`SELECT COUNT(*) AS c FROM set_bets WHERE state = 'placed'`)).c;
  assert.equal(stuck, 0);
  // The books balance for every user.
  await assertLedgerReconciles(users);
});

test('settleMarket refuses to settle a market whose opponent slot is still TBD', async () => {
  // Reproduces a real production bug: fillBracketSlot's stillActive guard can
  // return early for one slot (its player already has an active match
  // elsewhere) while the caller in scripts/sync-live.js still goes on to call
  // settleMarket unconditionally once start.gg reports the set as complete.
  // The result was a "settled" market with one side still the TBD sentinel
  // (id 0), rendered in the bracket as if TBD had won a real score.
  const r = await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, player1_id, player2_id,
       state, p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
     VALUES (1, 1, 'm-tbd', ?, 0, 'pending', 0.5, 0.5, 0, 0, 0)`,
    [P1]
  );
  const marketId = r.lastID;

  await lm.settleMarket(marketId, P1, 3, 0);

  const market = await db.getAsync('SELECT * FROM set_markets WHERE id = ?', [marketId]);
  assert.notEqual(market.state, 'settled', 'a market with an unfilled (TBD) slot must never be marked settled');
  assert.equal(market.winner_id, null);
});

test('house bankroll cache reflects settlement (invalidated, not stale)', async () => {
  for (const u of [1, 2]) await addUser(u);
  const marketId = await openMarket();

  // Before any settlement the bankroll is just the promo seed (0).
  assert.equal(await lm.houseBankrollCents(), 0);

  await lm.placeBet({ userId: 1, marketId, playerId: P1, amountCents: 1000 });
  await lm.placeBet({ userId: 2, marketId, playerId: P2, amountCents: 1000 });
  // Placed bets don't move the bankroll (they're excluded until won/lost).
  assert.equal(await lm.houseBankrollCents(), 0);

  await lm.settleMarket(marketId, P1, 2, 0);

  // After settling, the cache must reflect stakes-kept minus payouts — i.e. it was
  // invalidated, not serving the stale 0.
  const expected = (await db.getAsync(
    `SELECT COALESCE(SUM(amount_cents),0) - COALESCE(SUM(payout_cents),0) AS net
     FROM set_bets WHERE state IN ('won','lost')`)).net;
  assert.equal(await lm.houseBankrollCents(), expected);
  assert.notEqual(expected, 0); // sanity: a settlement actually moved it
});

test('clearDemoMarkets atomically reverses net wallet impact and removes rows', async () => {
  await addUser(1);
  // A demo market (matched by the 'demo-%' prefix) with a bet that gets settled.
  const r = await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, player1_id, player2_id,
       state, p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
     VALUES (1, 1, 'demo-1', ?, ?, 'open', 0.5, 0.5, 0, 1.9, 1.9)`,
    [P1, P2]
  );
  const marketId = r.lastID;
  await lm.placeBet({ userId: 1, marketId, playerId: P1, amountCents: 1000 });
  await lm.settleMarket(marketId, P1, 2, 0);
  assert.notEqual(await balance(1), START); // a payout actually moved the balance

  const res = await lm.clearDemoMarkets();
  assert.equal(res.cleared, 1);
  // Net wallet impact fully reversed, rows gone, books still reconcile.
  assert.equal(await balance(1), START);
  assert.equal((await db.getAsync(`SELECT COUNT(*) AS c FROM set_markets WHERE startgg_set_id LIKE 'demo-%'`)).c, 0);
  assert.equal((await db.getAsync('SELECT COUNT(*) AS c FROM set_bets')).c, 0);
  await assertLedgerReconciles([1]);
});

test('cancelBet refunds the stake, reverses the pool, and reconciles the ledger', async () => {
  await addUser(1);
  const marketId = await openMarket();
  const { betId } = await lm.placeBet({ userId: 1, marketId, playerId: P1, amountCents: 1000 });
  assert.equal(await balance(1), START - 1000);
  const beforeCancel = await db.getAsync('SELECT p1_pool_cents FROM set_markets WHERE id = ?', [marketId]);
  assert.equal(beforeCancel.p1_pool_cents, 1000);

  await lm.cancelBet(1, betId);

  assert.equal(await balance(1), START, 'stake must be fully refunded');
  await assertLedgerReconciles([1]);
  const bet = await db.getAsync('SELECT state, payout_cents FROM set_bets WHERE id = ?', [betId]);
  assert.equal(bet.state, 'refunded');
  assert.equal(bet.payout_cents, 1000);
  const market = await db.getAsync('SELECT p1_pool_cents FROM set_markets WHERE id = ?', [marketId]);
  assert.equal(market.p1_pool_cents, 0, "the cancelled stake's pool contribution must be reversed");
});

test('cancelBet refuses once the set has closed (started) even though the bet is still "placed"', async () => {
  await addUser(1);
  const marketId = await openMarket();
  const { betId } = await lm.placeBet({ userId: 1, marketId, playerId: P1, amountCents: 1000 });
  await lm.closeMarket(marketId, 1, 0); // set starts - betting locks, but the bet itself is still 'placed' until settlement

  await assert.rejects(() => lm.cancelBet(1, betId), (err) => err.code === 'MARKET_LOCKED');
  assert.equal(await balance(1), START - 1000, 'stake must stay locked in once the set has started');
});

test('cancelBet refuses a bet that belongs to someone else', async () => {
  await addUser(1);
  await addUser(2);
  const marketId = await openMarket();
  const { betId } = await lm.placeBet({ userId: 1, marketId, playerId: P1, amountCents: 1000 });

  await assert.rejects(() => lm.cancelBet(2, betId), (err) => err.code === 'FORBIDDEN');
  assert.equal(await balance(1), START - 1000, "another user's cancel attempt must not touch the real owner's stake");
});

test('cancelBet refuses a bet that has already been settled', async () => {
  await addUser(1);
  const marketId = await openMarket();
  const { betId } = await lm.placeBet({ userId: 1, marketId, playerId: P1, amountCents: 1000 });
  await lm.settleMarket(marketId, P1, 2, 0);
  const balanceAfterWin = await balance(1);

  await assert.rejects(() => lm.cancelBet(1, betId), (err) => err.code === 'NOT_CANCELLABLE');
  assert.equal(await balance(1), balanceAfterWin, 'a settled payout must never be touched by a cancel attempt');
});

// Sets up a preview_* market (the pre-real-set-ID placeholder the sync
// projects so users can bet on a matchup before start.gg assigns a real
// numeric set ID) with one bet placed on it, and returns enough to drive
// resolveStalePreviews against it.
async function openPreviewWithBet(userId, pickPlayerId, amountCents = 1000) {
  const preview = await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, player1_id, player2_id,
       state, p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
     VALUES (1, 1, 'preview_1_1_0', ?, ?, 'open', 0.5, 0.5, 0, 1.9, 1.9)`,
    [P1, P2]
  );
  const previewId = preview.lastID;
  const { betId } = await lm.placeBet({ userId, marketId: previewId, playerId: pickPlayerId, amountCents });
  return { previewId, betId };
}

test('resolveStalePreviews carries a placed bet over onto the real market when it is already open with both real players', async () => {
  // Reproduces a real production bug: once start.gg assigns a real numeric
  // set ID, the sync voids the earlier preview_* placeholder in favor of the
  // real market row (a different id) — but any bet still 'placed' on the
  // preview was never refunded, so it sat forever as 'placed' on a dead
  // market: invisible to "My Picks" (which only matches bets against the
  // currently-displayed market id) and stuck reading "Pending" on Home
  // forever. Now that the real market is known (both real players seated,
  // 'open'), the pick should carry over instead of just being refunded.
  await addUser(1);
  const { previewId, betId } = await openPreviewWithBet(1, P1, 1000);
  assert.equal(await balance(1), START - 1000);

  const realMarketId = await openMarket(); // startgg_set_id 'm-1', P1 vs P2, open

  await lm.resolveStalePreviews({ tournamentId: 1, startggSetId: 'm-1', playerIds: [P1, P2] });

  const previewMarket = await db.getAsync('SELECT state FROM set_markets WHERE id = ?', [previewId]);
  assert.equal(previewMarket.state, 'void');
  const oldBet = await db.getAsync('SELECT state, payout_cents FROM set_bets WHERE id = ?', [betId]);
  assert.equal(oldBet.state, 'refunded', 'the original preview bet is refunded, not left stuck as placed');
  assert.equal(oldBet.payout_cents, 1000);

  const restored = await db.getAsync(
    `SELECT * FROM set_bets WHERE market_id = ? AND user_id = 1 AND state = 'placed'`, [realMarketId]
  );
  assert.ok(restored, 'an equivalent bet must exist on the real market');
  assert.equal(restored.picked_player_id, P1);
  assert.equal(restored.amount_cents, 1000);
  assert.equal(await balance(1), START - 1000, 'net effect is the same stake now riding on the real market, not a free refund');
  await assertLedgerReconciles([1]);
});

test('resolveStalePreviews falls back to a plain refund when the picked player is not actually in the real market', async () => {
  await addUser(1);
  // Preview projected P1 vs P2; the user picked P2. By the time the real
  // bracket resolved, P2 had actually been eliminated by a third player
  // elsewhere, so the real match is P1 vs someone the preview never
  // projected - P2's pick has nobody to carry over onto.
  const { previewId, betId } = await openPreviewWithBet(1, P2, 1000);

  const OTHER = 999;
  await addUser(OTHER);
  const realMarketId = await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, player1_id, player2_id,
       state, p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
     VALUES (1, 1, 'm-real', ?, ?, 'open', 0.5, 0.5, 0, 1.9, 1.9)`,
    [P1, OTHER]
  ).then((r) => r.lastID);

  await lm.resolveStalePreviews({ tournamentId: 1, startggSetId: 'm-real', playerIds: [P1] });

  const previewMarket = await db.getAsync('SELECT state FROM set_markets WHERE id = ?', [previewId]);
  assert.equal(previewMarket.state, 'void');
  const bet = await db.getAsync('SELECT state, payout_cents FROM set_bets WHERE id = ?', [betId]);
  assert.equal(bet.state, 'refunded');
  assert.equal(bet.payout_cents, 1000);
  assert.equal(await balance(1), START, 'refunded in full since the picked player was never actually in this market');
  const carried = await db.getAsync(`SELECT * FROM set_bets WHERE market_id = ? AND user_id = 1`, [realMarketId]);
  assert.equal(carried, undefined, 'nothing should be placed on a market the bet was never actually eligible for');
  await assertLedgerReconciles([1]);
});

test('resolveStalePreviews refunds without restoring when the real market is not open yet', async () => {
  await addUser(1);
  const { previewId, betId } = await openPreviewWithBet(1, P1, 1000);

  // Only one real slot known so far - market exists but is still 'pending'.
  const pendingId = await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, player1_id, player2_id,
       state, p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
     VALUES (1, 1, 'm-pending', ?, 0, 'pending', 0.5, 0.5, 0, 0, 0)`,
    [P1]
  ).then((r) => r.lastID);

  await lm.resolveStalePreviews({ tournamentId: 1, startggSetId: 'm-pending', playerIds: [P1] });

  const bet = await db.getAsync('SELECT state, payout_cents FROM set_bets WHERE id = ?', [betId]);
  assert.equal(bet.state, 'refunded');
  assert.equal(await balance(1), START);
  const onPending = await db.getAsync(`SELECT * FROM set_bets WHERE market_id = ?`, [pendingId]);
  assert.equal(onPending, undefined, 'must never place a bet on a not-yet-open market');
  await assertLedgerReconciles([1]);
});
