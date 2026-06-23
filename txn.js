/**
 * Global write serialization + transactions for the single shared SQLite
 * connection. Every write that participates in money movement (the wallet
 * ledger, live markets/bets) runs through withWriteTx so that no two write
 * operations ever interleave their statements on the one connection. Each call
 * runs as one `BEGIN IMMEDIATE ... COMMIT` transaction, so a multi-step
 * read-modify-write (record bet -> debit stake -> grow pool -> reprice) is
 * atomic and rolls back fully on any error.
 *
 * NOT reentrant: never call withWriteTx (or wallet.credit/debit, which use it)
 * from inside a withWriteTx callback — that would deadlock on the mutex and
 * nest a transaction. Inside a transaction, use the raw wallet.applyCredit /
 * wallet.applyDebit primitives instead.
 */
const db = require('./db/db');
const { AsyncLocalStorage } = require('async_hooks');

// A promise chain acts as a mutex: each transaction waits for the previous one
// to finish (commit or roll back) before it begins.
let chain = Promise.resolve();

// Tracks whether the current async call stack is already inside a transaction,
// so we can reject a reentrant call instead of silently dead-locking the mutex
// (a nested withWriteTx would queue behind the very transaction it runs inside).
const txContext = new AsyncLocalStorage();

function withWriteTx(fn) {
  if (txContext.getStore()) {
    return Promise.reject(new Error(
      'withWriteTx is not reentrant — use the raw wallet.applyCredit/applyDebit primitives inside a transaction'));
  }
  const run = chain.then(() => txContext.run(true, async () => {
    await db.runAsync('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      await db.runAsync('COMMIT');
      return result;
    } catch (err) {
      try { await db.runAsync('ROLLBACK'); } catch (_) { /* nothing to roll back */ }
      throw err;
    }
  }));
  // Keep the chain alive regardless of this operation's outcome.
  chain = run.then(() => {}, () => {});
  return run;
}

module.exports = { withWriteTx };
