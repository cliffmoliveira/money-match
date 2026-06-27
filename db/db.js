require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

// Resolve the database path from environment variables or use default
const dbPath = path.resolve(process.env.DATABASE_PATH || './database.db');

// One-time seed hook: if "<dbPath>.seed" exists on disk (e.g. a migration
// snapshot uploaded onto a persistent volume out of band), swap it into place
// BEFORE opening the database — while nothing holds the file open. Stale WAL/SHM
// from any prior DB are cleared so SQLite won't replay an old journal over it.
// Self-consuming: the rename removes the .seed file, so it runs at most once.
const fs = require('fs');
const seedPath = `${dbPath}.seed`;
if (fs.existsSync(seedPath)) {
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${ext}`); } catch (_) { /* nothing to clear */ }
  }
  fs.renameSync(seedPath, dbPath);
  console.log(`Seeded database from ${seedPath}`);
}

// better-sqlite3 is a synchronous, in-process driver: no callback queue and no
// libuv threadpool hop per statement, so the write-heavy live-betting path runs
// much faster under load than node-sqlite3. We keep the SAME promise-returning
// interface (getAsync/allAsync/runAsync/closeAsync) the rest of the app already
// uses, so this is a drop-in swap — every `await db.getAsync(...)` keeps working
// and the global write mutex in txn.js still serializes transactions correctly.
const db = new Database(dbPath);
console.log(`Connected to the SQLite database at ${dbPath}`);

// Same tuning as before: WAL lets readers run alongside the single writer,
// busy_timeout makes a contended writer wait rather than throw, and
// synchronous=NORMAL (safe with WAL) avoids an fsync per commit.
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

// Cache prepared statements by SQL text. SQLite auto-reprepares on schema
// changes, so cached statements stay valid across migrations.
const stmtCache = new Map();
function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) { stmt = db.prepare(sql); stmtCache.set(sql, stmt); }
  return stmt;
}

// node-sqlite3 was lenient about bind values; better-sqlite3 only accepts
// numbers, strings, bigints, buffers, and null. Coerce the two values the
// codebase might pass (undefined / booleans) so call sites don't have to change.
function bindArgs(params) {
  return params.map((p) => (p === undefined ? null : p === true ? 1 : p === false ? 0 : p));
}

// Transaction control / pragmas / vacuum don't bind params and aren't ordinary
// prepared-and-run statements — route them through exec().
const EXEC_RE = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ATTACH|DETACH)\b/i;

// Promise-returning wrappers (the interface the rest of the app depends on).
db.allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    try { resolve(prepare(sql).all(...bindArgs(params))); }
    catch (err) { console.error('Error executing query:', err.message); reject(err); }
  });

db.getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    try { resolve(prepare(sql).get(...bindArgs(params))); }
    catch (err) { console.error('Error fetching row:', err.message); reject(err); }
  });

db.runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    try {
      if (params.length === 0 && EXEC_RE.test(sql)) {
        db.exec(sql);
        resolve({ lastID: 0, changes: 0 });
      } else {
        const info = prepare(sql).run(...bindArgs(params));
        // Match node-sqlite3's `this` shape: lastID + changes.
        resolve({ lastID: Number(info.lastInsertRowid), changes: info.changes });
      }
    } catch (err) { console.error('Error running query:', err.message); reject(err); }
  });

db.closeAsync = () =>
  new Promise((resolve) => {
    db.close();
    console.log('Database connection closed.');
    resolve();
  });

module.exports = db;
