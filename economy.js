/**
 * Fight Money economy rules: bet sizing, bust recovery, and daily refills for the
 * virtual-currency betting wallet (users.balance_cents, exposed to users as "Fight
 * Money"; 1 FM = 100 cents). All amounts are integer cents. This layer sits on
 * top of the generic ledger in wallet.js and never touches real money — refills
 * are pure upside and reinforce the no-cash-value posture.
 */
const db = require('./db/db');
const wallet = require('./wallet');

const MIN_BET_CENTS = 100;       // 1 FM — smallest allowed stake
const BET_CAP_PCT = 0.10;        // a single bet can't exceed 10% of current balance
const MERCY_FLOOR_CENTS = 500;   // top up to 5 FM when broke, so there's no dead-end zero

// Daily login streak: ramps Day 1 -> Day 7, then holds at the Day-7 amount. Cents.
const DAILY_BONUS_RAMP = [2500, 5000, 7500, 10000, 12500, 15000, 20000]; // 25 FM .. 200 FM
const DAY_MS = 24 * 60 * 60 * 1000;

// Largest single bet allowed at this balance — the % cap, but never below the
// minimum (so a low-balance user can still place exactly one min bet).
function maxBetCents(balanceCents) {
  return Math.max(MIN_BET_CENTS, Math.floor((Number(balanceCents) || 0) * BET_CAP_PCT));
}

// Fight Money granted for claiming on the Nth consecutive day (1-indexed).
function dailyBonusForStreak(streak) {
  const i = Math.min(Math.max(streak, 1), DAILY_BONUS_RAMP.length) - 1;
  return DAILY_BONUS_RAMP[i];
}

// Validate a stake against the min/cap rules. Throws a coded error (mapped to a
// 400 by the route) so the message reaches the user verbatim.
function assertBetWithinLimits(amountCents, balanceCents) {
  if (amountCents < MIN_BET_CENTS) {
    const e = new Error(`Minimum bet is ${MIN_BET_CENTS / 100} FM.`);
    e.code = 'BELOW_MIN';
    throw e;
  }
  const cap = maxBetCents(balanceCents);
  if (amountCents > cap) {
    const e = new Error(`Max bet is ${cap / 100} FM (10% of your Fight Money).`);
    e.code = 'ABOVE_CAP';
    throw e;
  }
}

// Bust recovery: if the user is below one min bet, mercy-credit up to the floor so
// they're never stuck at an unplayable zero. Atomic (via wallet.creditToFloor) so
// concurrent wallet polls can't double-credit; a no-op once balance >= MIN_BET.
async function applyMercyFloor(userId) {
  return wallet.creditToFloor(userId, MERCY_FLOOR_CENTS, MIN_BET_CENTS, 'mercy_floor');
}

// What the user would get by claiming right now (for the "Claim" button).
async function dailyBonusStatus(userId, now = Date.now()) {
  const row = await db.getAsync('SELECT last_daily_bonus_at, daily_streak FROM users WHERE id = ?', [userId]);
  if (!row) return null;
  const last = row.last_daily_bonus_at ? Date.parse(row.last_daily_bonus_at) : null;
  const available = last === null || now - last >= DAY_MS;
  // Streak continues only if the previous claim was within the last 48h.
  const nextStreak = last !== null && now - last < 2 * DAY_MS ? (row.daily_streak || 0) + 1 : 1;
  return {
    available,
    day: nextStreak,                          // which streak day a claim now would be
    amountCents: dailyBonusForStreak(nextStreak),
    currentStreak: row.daily_streak || 0,
    ramp: DAILY_BONUS_RAMP,                    // full 7-day ladder for the client streak tracker
    nextAt: last !== null ? new Date(last + DAY_MS).toISOString() : null, // null = available now
  };
}

// Claim the daily Fight Money bonus. Idempotent within a 24h window. `now` is
// injectable for testing.
async function claimDailyBonus(userId, now = Date.now()) {
  const row = await db.getAsync('SELECT last_daily_bonus_at, daily_streak FROM users WHERE id = ?', [userId]);
  if (!row) return { error: 'NOT_FOUND' };
  const last = row.last_daily_bonus_at ? Date.parse(row.last_daily_bonus_at) : null;
  if (last !== null && now - last < DAY_MS) {
    return {
      claimed: false,
      streak: row.daily_streak || 0,
      balanceCents: await wallet.getBalance(userId),
      nextAt: new Date(last + DAY_MS).toISOString(),
    };
  }
  const streak = last !== null && now - last < 2 * DAY_MS ? (row.daily_streak || 0) + 1 : 1;
  // Compare-and-swap claim guard: stamp last_daily_bonus_at only if it still holds
  // the value we read. Of two racing requests, exactly one matches and credits;
  // the other sees the changed value, gets changes=0, and is treated as a no-op.
  const guard = await db.runAsync(
    'UPDATE users SET last_daily_bonus_at = ?, daily_streak = ? WHERE id = ? AND last_daily_bonus_at IS ?',
    [new Date(now).toISOString(), streak, userId, row.last_daily_bonus_at]
  );
  if (guard.changes !== 1) {
    return { claimed: false, streak: row.daily_streak || 0, balanceCents: await wallet.getBalance(userId), nextAt: new Date(now + DAY_MS).toISOString() };
  }
  const amountCents = dailyBonusForStreak(streak);
  const balanceCents = await wallet.credit(userId, amountCents, 'daily_bonus');
  return { claimed: true, amountCents, streak, balanceCents, nextAt: new Date(now + DAY_MS).toISOString() };
}

// Idempotent, additive schema for the daily-bonus bookkeeping on users.
async function applyEconomySchema(database = db) {
  const cols = await database.allAsync('PRAGMA table_info(users)');
  const has = (c) => cols.some((x) => x.name === c);
  if (!has('last_daily_bonus_at')) await database.runAsync('ALTER TABLE users ADD COLUMN last_daily_bonus_at TEXT');
  if (!has('daily_streak')) await database.runAsync('ALTER TABLE users ADD COLUMN daily_streak INTEGER NOT NULL DEFAULT 0');
}

module.exports = {
  MIN_BET_CENTS, BET_CAP_PCT, MERCY_FLOOR_CENTS, DAILY_BONUS_RAMP,
  maxBetCents, dailyBonusForStreak, assertBetWithinLimits,
  applyMercyFloor, dailyBonusStatus, claimDailyBonus, applyEconomySchema,
};
