const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Coverage for reconcileOneStaleMarket - the low-frequency safety net that
// re-checks a set_markets row directly against start.gg once it's aged out
// of the 60s live poller's own selection (see getActiveTournaments'
// STALE_PENDING_DAYS cutoff). Reproduces the real production bug found on
// "KOF XV & SAMSHO at EVO 2026 BYOC": two sets sat 'pending' in our DB for
// a week after start.gg had already recorded real, decisive results for
// both, because the tournament aged out of the poller's selection first.
let db, lm, sync, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-reconcile-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
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

async function seedMarket({ state, startggSetId = '104770041', p1StartggId = 'e-a', p2StartggId = 'e-b' }) {
  const gameRes = await db.runAsync(`INSERT INTO games (name, startgg_id) VALUES ('The King of Fighters XV', 'g1')`);
  const tRes = await db.runAsync(`INSERT INTO tournaments (name, date, startgg_id) VALUES ('KOF Test', '2026-06-26', 't1')`);
  const p1Res = await db.runAsync(`INSERT INTO players (name, startgg_id) VALUES ('Madkof', ?)`, [p1StartggId]);
  const p2Res = await db.runAsync(`INSERT INTO players (name, startgg_id) VALUES ('SCORE', ?)`, [p2StartggId]);
  const mRes = await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id, state, p1_prob, p2_prob)
     VALUES (?, ?, ?, 'Winners Semi-Final', ?, ?, ?, 0.5, 0.5)`,
    [tRes.lastID, gameRes.lastID, startggSetId, p1Res.lastID, p2Res.lastID, state]
  );
  return { marketId: mRes.lastID, tournamentId: tRes.lastID, p1: p1Res.lastID, p2: p2Res.lastID, startggSetId };
}

test('settles a pending market once start.gg reports it complete (real production case)', async () => {
  const { marketId, p1, p2, startggSetId } = await seedMarket({ state: 'pending' });
  const set = {
    state: 3,
    winnerId: 'e-a',
    slots: [
      { entrant: { id: 'e-a', name: 'Madkof', participants: [] }, standing: { stats: { score: { value: 3 } } } },
      { entrant: { id: 'e-b', name: 'SCORE', participants: [] }, standing: { stats: { score: { value: 1 } } } },
    ],
  };
  const result = await sync.reconcileOneStaleMarket({ id: marketId, startgg_set_id: startggSetId, player1_id: p1, player2_id: p2, round_text: 'Winners Semi-Final' }, set);
  assert.equal(result, 'settled');

  const market = await db.getAsync('SELECT * FROM set_markets WHERE id = ?', [marketId]);
  assert.equal(market.state, 'settled');
  assert.equal(market.winner_id, p1);
  assert.equal(market.p1_score, 3);
  assert.equal(market.p2_score, 1);
});

test('grades a real placed bet when settling a stale market, exactly like the live poller would', async () => {
  const { marketId, p1, p2 } = await seedMarket({ state: 'open' });
  const uRes = await db.runAsync(`INSERT INTO users (balance_cents) VALUES (10000)`);
  await db.runAsync(
    `INSERT INTO set_bets (user_id, market_id, picked_player_id, amount_cents, locked_odds) VALUES (?, ?, ?, 3300, 1.5)`,
    [uRes.lastID, marketId, p1]
  );

  const set = {
    state: 3, winnerId: 'e-a',
    slots: [
      { entrant: { id: 'e-a', name: 'Madkof', participants: [] }, standing: { stats: { score: { value: 3 } } } },
      { entrant: { id: 'e-b', name: 'SCORE', participants: [] }, standing: { stats: { score: { value: 1 } } } },
    ],
  };
  await sync.reconcileOneStaleMarket({ id: marketId, startgg_set_id: '104770041', player1_id: p1, player2_id: p2, round_text: 'Winners Semi-Final' }, set);

  const bet = await db.getAsync('SELECT * FROM set_bets WHERE market_id = ?', [marketId]);
  assert.equal(bet.state, 'won');
  assert.ok(bet.payout_cents > 0);
});

test('closes (does not settle) a market that is still in-progress on start.gg', async () => {
  const { marketId, p1, p2 } = await seedMarket({ state: 'open' });
  const set = {
    state: 2, winnerId: null,
    slots: [
      { entrant: { id: 'e-a', name: 'Madkof', participants: [] }, standing: { stats: { score: { value: 1 } } } },
      { entrant: { id: 'e-b', name: 'SCORE', participants: [] }, standing: { stats: { score: { value: 0 } } } },
    ],
  };
  const result = await sync.reconcileOneStaleMarket({ id: marketId, startgg_set_id: '104770041', player1_id: p1, player2_id: p2, round_text: 'Winners Semi-Final' }, set);
  assert.equal(result, 'closed');
  const market = await db.getAsync('SELECT state FROM set_markets WHERE id = ?', [marketId]);
  assert.equal(market.state, 'closed');
});

test('leaves a market untouched when start.gg still reports it unresolved (not yet started)', async () => {
  const { marketId, p1, p2 } = await seedMarket({ state: 'pending' });
  const set = {
    state: 1, winnerId: null,
    slots: [
      { entrant: { id: 'e-a', name: 'Madkof', participants: [] }, standing: null },
      { entrant: { id: 'e-b', name: 'SCORE', participants: [] }, standing: null },
    ],
  };
  const result = await sync.reconcileOneStaleMarket({ id: marketId, startgg_set_id: '104770041', player1_id: p1, player2_id: p2, round_text: 'Winners Semi-Final' }, set);
  assert.equal(result, 'skipped');
  const market = await db.getAsync('SELECT state FROM set_markets WHERE id = ?', [marketId]);
  assert.equal(market.state, 'pending');
});

test('skips (never guesses) when start.gg no longer has the set at all', async () => {
  const { marketId, p1, p2 } = await seedMarket({ state: 'open' });
  const result = await sync.reconcileOneStaleMarket({ id: marketId, startgg_set_id: '104770041', player1_id: p1, player2_id: p2, round_text: 'Winners Semi-Final' }, null);
  assert.equal(result, 'skipped');
  const market = await db.getAsync('SELECT state FROM set_markets WHERE id = ?', [marketId]);
  assert.equal(market.state, 'open');
});
