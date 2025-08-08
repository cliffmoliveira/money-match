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
