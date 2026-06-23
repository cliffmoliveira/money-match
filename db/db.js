require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Resolve the database path from environment variables or use default
const dbPath = path.resolve(process.env.DATABASE_PATH || './database.db');

// Initialize the database connection
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log(`Connected to the SQLite database at ${dbPath}`);
  }
});

// Tune the connection for concurrent load (e.g. an EVO Top-8 betting burst).
// These run first because node-sqlite3 serializes statements in submission order.
//  • WAL lets readers (live page, wallet, bets) run alongside the single writer
//    instead of queuing behind every write.
//  • busy_timeout makes a contended writer wait-and-retry instead of immediately
//    throwing SQLITE_BUSY.
//  • synchronous=NORMAL is the safe-with-WAL setting that avoids an fsync per
//    commit (durable across app crashes; only a power-loss mid-checkpoint risk).
db.run('PRAGMA journal_mode = WAL', (err) => {
  if (err) console.error('Failed to enable WAL mode:', err.message);
});
db.run('PRAGMA busy_timeout = 5000', (err) => {
  if (err) console.error('Failed to set busy_timeout:', err.message);
});
db.run('PRAGMA synchronous = NORMAL', (err) => {
  if (err) console.error('Failed to set synchronous=NORMAL:', err.message);
});

// Promisify database methods for async/await
db.allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error('Error executing query:', err.message);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });

db.runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        console.error('Error running query:', err.message);
        reject(err);
      } else {
        resolve(this);
      }
    });
  });

db.getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        console.error('Error fetching row:', err.message);
        reject(err);
      } else {
        resolve(row);
      }
    });
  });

db.closeAsync = () =>
  new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        console.error('Error closing the database:', err.message);
        reject(err);
      } else {
        console.log('Database connection closed.');
        resolve();
      }
    });
  });

module.exports = db;
