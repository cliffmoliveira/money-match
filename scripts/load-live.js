/**
 * Concurrent HTTP load test for the live betting path — the "EVO Top-8 burst"
 * the scalability audit flagged. Fires many parallel POST /api/live/bets at a
 * RUNNING server, measures throughput + latency + error mix, then settles the
 * market and asserts the books still reconcile.
 *
 * It does NOT start the server — point both at the same DATABASE_PATH:
 *   1. DATABASE_PATH=/tmp/load.db DISABLE_SYNC=1 ENABLE_DEMO=1 PORT=5055 node server.js &
 *   2. DATABASE_PATH=/tmp/load.db BASE_URL=http://localhost:5055 node scripts/load-live.js \
 *        --users 200 --concurrency 150 --total 4000 --stake 100
 *
 * No new dependencies: built-in fetch + jsonwebtoken (already a dep). Seeds its
 * own minimal schema + test users + one open market, so it runs against a fresh
 * throwaway DB.
 */
const jwt = require('jsonwebtoken');
const db = require('../db/db');
const lm = require('../liveMarkets');

const secretKey = process.env.JWT_SECRET || 'your_secret_key';
const BASE = process.env.BASE_URL || 'http://localhost:5055';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : def;
};
const USERS = Number(arg('users', 200));
const CONC = Number(arg('concurrency', 150));
const TOTAL = Number(arg('total', 4000));
const STAKE = Number(arg('stake', 100)); // cents (1 FM min)

const UID = 900000;            // test users occupy a high id range
const P1 = 990001, P2 = 990002;
const START_BAL = 5_000_000;   // 50,000 FM — far above the 10% cap for these stakes

async function setup() {
  await db.runAsync(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount_cents INTEGER, type TEXT,
    ref_type TEXT, ref_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS set_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER, startgg_set_id TEXT,
    round_text TEXT, round_int INTEGER, phase_group_id TEXT,
    player1_id INTEGER, player2_id INTEGER, p1_seed INTEGER, p2_seed INTEGER,
    state TEXT NOT NULL DEFAULT 'open', p1_prob REAL, p2_prob REAL, seed_k_cents INTEGER DEFAULT 0,
    p1_live_odds REAL, p2_live_odds REAL,
    p1_pool_cents INTEGER NOT NULL DEFAULT 0, p2_pool_cents INTEGER NOT NULL DEFAULT 0,
    winner_id INTEGER, p1_score INTEGER, p2_score INTEGER,
    opened_at TEXT, closed_at TEXT, settled_at TEXT)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS set_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, market_id INTEGER, picked_player_id INTEGER,
    amount_cents INTEGER, locked_odds REAL, state TEXT NOT NULL DEFAULT 'placed',
    payout_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_set_bets_state ON set_bets(state)`);

  // Fresh slate so re-runs are deterministic.
  await db.runAsync('DELETE FROM set_bets');
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync(`DELETE FROM wallet_transactions WHERE user_id > ?`, [UID]);
  await db.runAsync(`DELETE FROM users WHERE id > ?`, [UID]);

  for (let i = 1; i <= USERS; i++) {
    await db.runAsync('INSERT OR REPLACE INTO users (id, balance_cents) VALUES (?, ?)', [UID + i, START_BAL]);
  }
  const r = await db.runAsync(
    `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, player1_id, player2_id,
       state, p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
     VALUES (1, 1, 'load-mkt', ?, ?, 'open', 0.5, 0.5, 0, 1.9, 1.9)`,
    [P1, P2]
  );
  return r.lastID;
}

async function placeBet(token, marketId, playerId) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/live/bets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ marketId, playerId, amountCents: STAKE }),
    });
    const ms = performance.now() - t0;
    let err = null;
    if (res.status >= 400) { try { err = (await res.json()).error; } catch { /* ignore */ } }
    return { status: res.status, ms, err };
  } catch (e) {
    return { status: 0, ms: performance.now() - t0, err: e.message };
  }
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

async function ledgerReconciles() {
  // Every user's balance must equal their starting grant plus the sum of their
  // ledger entries — no money created or lost outside the ledger under load.
  const rows = await db.allAsync(
    `SELECT u.id, u.balance_cents AS bal, COALESCE(t.s,0) AS led
     FROM users u
     LEFT JOIN (SELECT user_id, SUM(amount_cents) AS s FROM wallet_transactions GROUP BY user_id) t ON t.user_id = u.id
     WHERE u.id > ?`, [UID]);
  const bad = rows.filter((r) => r.bal !== START_BAL + r.led);
  const neg = rows.filter((r) => r.bal < 0);
  return { ok: bad.length === 0 && neg.length === 0, bad: bad.length, neg: neg.length, checked: rows.length };
}

async function main() {
  console.log(`load-live: ${BASE}  users=${USERS} concurrency=${CONC} total=${TOTAL} stake=${STAKE}c`);
  const marketId = await setup();
  const tokens = Array.from({ length: USERS }, (_, i) => jwt.sign({ id: UID + 1 + i }, secretKey));

  const results = new Array(TOTAL);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < TOTAL; i = next++) {
      results[i] = await placeBet(tokens[i % USERS], marketId, i % 2 === 0 ? P1 : P2);
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  const wall = (performance.now() - t0) / 1000;

  // ---- Throughput + latency ----
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const status = {};
  const errs = {};
  let ok = 0, locked = 0;
  for (const r of results) {
    status[r.status] = (status[r.status] || 0) + 1;
    if (r.status === 201) ok++;
    if (r.err) errs[r.err] = (errs[r.err] || 0) + 1;
    if (r.err && /lock|busy/i.test(r.err)) locked++;
  }
  console.log(`\n— throughput —`);
  console.log(`  wall ${wall.toFixed(2)}s | ${(results.length / wall).toFixed(0)} req/s | ${(ok / wall).toFixed(0)} accepted-bets/s | ${ok}/${results.length} accepted`);
  console.log(`— latency (ms) —`);
  console.log(`  p50 ${pct(lat, 50).toFixed(0)} | p95 ${pct(lat, 95).toFixed(0)} | p99 ${pct(lat, 99).toFixed(0)} | max ${pct(lat, 100).toFixed(0)}`);
  console.log(`— status codes —  ${JSON.stringify(status)}`);
  if (Object.keys(errs).length) console.log(`— errors —  ${JSON.stringify(errs)}`);
  console.log(`  SQLITE_BUSY / "database is locked": ${locked}`);

  // ---- Settlement (the per-winner payout burst) ----
  const st0 = performance.now();
  const settled = await lm.settleMarket(marketId, P1, 2, 1);
  const settleMs = performance.now() - st0;
  console.log(`\n— settlement —`);
  console.log(`  settled ${settled ? settled.settled : 0} bets in ${settleMs.toFixed(0)}ms (one transaction)`);

  // ---- Integrity ----
  const betRows = (await db.getAsync('SELECT COUNT(*) AS c FROM set_bets')).c;
  const stakeDebits = (await db.getAsync(`SELECT COUNT(*) AS c FROM wallet_transactions WHERE type='bet_stake'`)).c;
  const placedLeft = (await db.getAsync(`SELECT COUNT(*) AS c FROM set_bets WHERE state='placed'`)).c;
  const recon = await ledgerReconciles();
  console.log(`\n— integrity —`);
  console.log(`  bet rows == accepted: ${betRows === ok ? 'OK' : 'MISMATCH'} (${betRows} vs ${ok})`);
  console.log(`  one stake-debit per bet: ${stakeDebits === betRows ? 'OK' : 'MISMATCH'} (${stakeDebits} debits)`);
  console.log(`  no bet stuck in 'placed' post-settle: ${placedLeft === 0 ? 'OK' : 'FAIL'} (${placedLeft})`);
  console.log(`  every user's books reconcile: ${recon.ok ? 'OK' : 'FAIL'} (checked ${recon.checked}, bad ${recon.bad}, negative ${recon.neg})`);

  const pass = betRows === ok && stakeDebits === betRows && placedLeft === 0 && recon.ok && locked === 0;
  console.log(`\nRESULT: ${pass ? 'PASS — held up, books balanced' : 'ATTENTION — see mismatches above'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('load-live failed:', e); process.exit(2); });
