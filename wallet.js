/**
 * Play-money wallet. Ledger-based and funding-source-agnostic: every balance
 * change writes a row to wallet_transactions and adjusts users.balance_cents.
 * Swapping to crypto/USD later means adding deposit/withdrawal transaction
 * types, not changing this interface. All amounts are integer cents.
 */
const db = require('./db/db');

const STARTING_GRANT_CENTS = 100000; // $1000

// Serialize wallet mutations through a single promise chain so concurrent
// requests can't interleave a read-modify-write on the shared db connection.
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  // keep the chain alive even if fn rejects
  queue = run.then(() => {}, () => {});
  return run;
}

async function getBalance(userId) {
  const row = await db.getAsync('SELECT balance_cents FROM users WHERE id = ?', [userId]);
  return row ? row.balance_cents : null;
}

async function credit(userId, cents, type, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('credit amount must be a positive integer (cents)');
  return serialize(async () => {
    await db.runAsync('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?', [cents, userId]);
    await db.runAsync(
      `INSERT INTO wallet_transactions (user_id, amount_cents, type, ref_type, ref_id) VALUES (?, ?, ?, ?, ?)`,
      [userId, cents, type, ref.type || null, ref.id || null]
    );
    return getBalance(userId);
  });
}

async function debit(userId, cents, type, ref = {}) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('debit amount must be a positive integer (cents)');
  return serialize(async () => {
    // Conditional update is atomic: only deducts when funds are sufficient.
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
    return getBalance(userId);
  });
}

async function getTransactions(userId, limit = 50) {
  return db.allAsync(
    `SELECT id, amount_cents, type, ref_type, ref_id, created_at
     FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    [userId, limit]
  );
}

module.exports = { STARTING_GRANT_CENTS, getBalance, credit, debit, getTransactions };
