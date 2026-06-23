/**
 * Virtual-currency wallet. Ledger-based and funding-source-agnostic: every balance
 * change writes a row to wallet_transactions and adjusts users.balance_cents.
 * Swapping to crypto/USD later means adding deposit/withdrawal transaction
 * types, not changing this interface. All amounts are integer cents.
 *
 * Concurrency model: all mutations go through the global write mutex in txn.js.
 * The public credit/debit/creditToFloor each run as their own transaction. The
 * raw applyCredit/applyDebit primitives do the ledger writes WITHOUT taking the
 * mutex, so a larger operation (e.g. live bet placement or settlement) can bundle
 * several ledger writes into one atomic transaction it already owns.
 */
const db = require('./db/db');
const { withWriteTx } = require('./txn');

const STARTING_GRANT_CENTS = 100000; // $1000

async function getBalance(userId) {
  const row = await db.getAsync('SELECT balance_cents FROM users WHERE id = ?', [userId]);
  return row ? row.balance_cents : null;
}

// ---- Raw ledger primitives. MUST be called inside an active withWriteTx. ----

// Add funds + record a ledger row. Caller owns the transaction.
async function applyCredit(userId, cents, type, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('credit amount must be a positive integer (cents)');
  await db.runAsync('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [cents, userId]);
  await db.runAsync(
    `INSERT INTO wallet_transactions (user_id, amount_cents, type, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)`,
    [userId, cents, type, ref.type || null, ref.id || null]
  );
}

// Deduct funds (atomic, only when sufficient) + record a ledger row. Throws
// INSUFFICIENT_FUNDS otherwise so the caller's transaction rolls back. Caller
// owns the transaction.
async function applyDebit(userId, cents, type, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('debit amount must be a positive integer (cents)');
  const result = await db.runAsync(
    'UPDATE users SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?',
    [cents, userId, cents]
  );
  if (result.changes !== 1) {
    const err = new Error('Insufficient funds');
    err.code = 'INSUFFICIENT_FUNDS';
    throw err;
  }
  await db.runAsync(
    `INSERT INTO wallet_transactions (user_id, amount_cents, type, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)`,
    [userId, -cents, type, ref.type || null, ref.id || null]
  );
}

// ---- Public API: each runs as one serialized transaction. ----

async function credit(userId, cents, type, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('credit amount must be a positive integer (cents)');
  return withWriteTx(async () => {
    await applyCredit(userId, cents, type, ref);
    return getBalance(userId);
  });
}

async function debit(userId, cents, type, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('debit amount must be a positive integer (cents)');
  return withWriteTx(async () => {
    await applyDebit(userId, cents, type, ref);
    return getBalance(userId);
  });
}

// Atomically top a balance up to `floorCents`, but only when it's below
// `minCents`. The read-check-write runs in one transaction so concurrent polls
// can't double-credit. Records a ledger row only when it actually credits.
// Returns the resulting balance (or null if the user doesn't exist).
async function creditToFloor(userId, floorCents, minCents, type, ref = {}) {
  return withWriteTx(async () => {
    const before = await getBalance(userId);
    if (before === null || before >= minCents) return before;
    const delta = floorCents - before;
    await db.runAsync('UPDATE users SET balance_cents = ? WHERE id = ?', [floorCents, userId]);
    await db.runAsync(
      `INSERT INTO wallet_transactions (user_id, amount_cents, type, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)`,
      [userId, delta, type, ref.type || null, ref.id || null]
    );
    return floorCents;
  });
}

async function getTransactions(userId, limit = 50) {
  return db.allAsync(
    `SELECT id, amount_cents, type, ref_type, ref_id, created_at
     FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    [userId, limit]
  );
}

module.exports = {
  STARTING_GRANT_CENTS, getBalance, credit, debit, creditToFloor, getTransactions,
  // Raw primitives — ONLY call inside an active withWriteTx transaction.
  applyCredit, applyDebit,
};
