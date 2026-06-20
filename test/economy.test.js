// Fight Money economy: bet sizing, mercy floor, and daily-bonus streak logic.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let db, economy, file;
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-06-19T12:00:00Z');

before(async () => {
  file = path.join(os.tmpdir(), `mm-economy-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  for (const m of ['../db/db', '../wallet', '../economy']) delete require.cache[require.resolve(m)];
  db = require('../db/db');
  economy = require('../economy');
  await db.runAsync('CREATE TABLE users (id INTEGER PRIMARY KEY, balance_cents INTEGER NOT NULL DEFAULT 0)');
  await db.runAsync(`CREATE TABLE wallet_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount_cents INTEGER,
    type TEXT, ref_type TEXT, ref_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`);
  await economy.applyEconomySchema(db);
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

beforeEach(async () => {
  await db.runAsync('DELETE FROM users');
  await db.runAsync('DELETE FROM wallet_transactions');
  await db.runAsync('INSERT INTO users (id, balance_cents) VALUES (1, 0)');
});

test('maxBetCents: 10% cap, floored, never below the min bet', () => {
  assert.equal(economy.maxBetCents(100000), 10000); // 10% of 1000 FM = 100 FM
  assert.equal(economy.maxBetCents(500), 100);      // 10% = 50 -> clamped to 100 (min)
  assert.equal(economy.maxBetCents(0), 100);
});

test('dailyBonusForStreak: ramps Day 1..7 then holds', () => {
  assert.equal(economy.dailyBonusForStreak(1), 2500);
  assert.equal(economy.dailyBonusForStreak(7), 20000);
  assert.equal(economy.dailyBonusForStreak(99), 20000);
  assert.equal(economy.dailyBonusForStreak(0), 2500); // clamps up to Day 1
});

test('assertBetWithinLimits: enforces min and cap', () => {
  assert.throws(() => economy.assertBetWithinLimits(50, 100000), /Minimum bet/);
  assert.throws(() => economy.assertBetWithinLimits(20000, 100000), /Max bet/); // > 10% of 1000 FM
  assert.doesNotThrow(() => economy.assertBetWithinLimits(100, 100000));
  assert.doesNotThrow(() => economy.assertBetWithinLimits(10000, 100000));
});

test('applyMercyFloor: tops a broke user up to the floor, leaves a funded one alone', async () => {
  await db.runAsync('UPDATE users SET balance_cents = 0 WHERE id = 1');
  assert.equal(await economy.applyMercyFloor(1), 500);
  await db.runAsync('UPDATE users SET balance_cents = 600 WHERE id = 1');
  assert.equal(await economy.applyMercyFloor(1), 600);
});

test('claimDailyBonus: grows daily, idempotent within 24h, resets after a missed day', async () => {
  const r1 = await economy.claimDailyBonus(1, T0);
  assert.equal(r1.claimed, true);
  assert.equal(r1.streak, 1);
  assert.equal(r1.amountCents, 2500);
  assert.equal(r1.balanceCents, 2500);

  // Same day -> no double claim.
  const r2 = await economy.claimDailyBonus(1, T0 + 1 * HOUR);
  assert.equal(r2.claimed, false);
  assert.equal(r2.streak, 1);

  // Next day (25h later) -> streak 2.
  const r3 = await economy.claimDailyBonus(1, T0 + 25 * HOUR);
  assert.equal(r3.claimed, true);
  assert.equal(r3.streak, 2);
  assert.equal(r3.amountCents, 5000);

  // Miss a day (>48h after the day-2 claim) -> reset to 1.
  const r4 = await economy.claimDailyBonus(1, T0 + 25 * HOUR + 50 * HOUR);
  assert.equal(r4.claimed, true);
  assert.equal(r4.streak, 1);
  assert.equal(r4.amountCents, 2500);
});

test('dailyBonusStatus: availability + the amount a claim would grant', async () => {
  const s0 = await economy.dailyBonusStatus(1, T0);
  assert.equal(s0.available, true);
  assert.equal(s0.day, 1);
  assert.equal(s0.amountCents, 2500);

  await economy.claimDailyBonus(1, T0);
  const s1 = await economy.dailyBonusStatus(1, T0 + 1 * HOUR);
  assert.equal(s1.available, false);

  const s2 = await economy.dailyBonusStatus(1, T0 + 25 * HOUR);
  assert.equal(s2.available, true);
  assert.equal(s2.day, 2);
  assert.equal(s2.amountCents, 5000);
});

test('applyMercyFloor: concurrent calls credit exactly once (atomic)', async () => {
  await db.runAsync('UPDATE users SET balance_cents = 0 WHERE id = 1');
  await Promise.all([economy.applyMercyFloor(1), economy.applyMercyFloor(1), economy.applyMercyFloor(1)]);
  assert.equal((await db.getAsync('SELECT balance_cents AS b FROM users WHERE id = 1')).b, 500);
  const credits = (await db.getAsync("SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = 1 AND type = 'mercy_floor'")).n;
  assert.equal(credits, 1);
});

test('claimDailyBonus: concurrent claims credit exactly once (CAS guard)', async () => {
  const [a, b] = await Promise.all([economy.claimDailyBonus(1, T0), economy.claimDailyBonus(1, T0)]);
  assert.equal([a, b].filter((r) => r.claimed).length, 1);
  assert.equal((await db.getAsync('SELECT balance_cents AS b FROM users WHERE id = 1')).b, 2500);
  assert.equal((await db.getAsync('SELECT daily_streak AS s FROM users WHERE id = 1')).s, 1);
});
