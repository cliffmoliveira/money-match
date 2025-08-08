const sqlite3 = require('sqlite3').verbose();

// Connect to the SQLite database
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

// Function to initialize the database schema
const initializeDatabase = () => {
  // Create Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `, (err) => {
    if (err) {
      console.error('Error creating users table:', err.message);
    } else {
      console.log('Users table created or already exists.');
    }
  });

  // Create Matches table
  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
  `, (err) => {
    if (err) {
      console.error('Error creating matches table:', err.message);
    } else {
      console.log('Matches table created or already exists.');
    }
  });

  // Create Bets table
  db.run(`
    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      FOREIGN KEY (match_id) REFERENCES matches (id),
      FOREIGN KEY (user_id) REFERENCES users (id)
    );
  `, (err) => {
    if (err) {
      console.error('Error creating bets table:', err.message);
    } else {
      console.log('Bets table created or already exists.');
    }
  });

  // Insert sample data
  insertSampleData();
};

// Function to insert sample data
const insertSampleData = () => {
  // Insert sample users
  const sampleUsers = [
    { username: 'user1', email: 'user1@example.com', password: 'hashedpassword1' },
    { username: 'user2', email: 'user2@example.com', password: 'hashedpassword2' },
  ];
  sampleUsers.forEach(({ username, email, password }) => {
    db.run(
      `INSERT OR IGNORE INTO users (username, email, password) VALUES (?, ?, ?)`,
      [username, email, password],
      (err) => {
        if (err) {
          console.error(`Error inserting user ${username}:`, err.message);
        }
      }
    );
  });

  // Insert sample matches
  const sampleMatches = [
    { name: 'Player1 vs Player2' },
    { name: 'Player3 vs Player4' },
  ];
  sampleMatches.forEach(({ name }) => {
    db.run(
      `INSERT OR IGNORE INTO matches (name) VALUES (?)`,
      [name],
      (err) => {
        if (err) {
          console.error(`Error inserting match ${name}:`, err.message);
        }
      }
    );
  });

  console.log('Sample data inserted.');
};

// Initialize the database and close the connection
initializeDatabase();

db.close((err) => {
  if (err) {
    console.error('Error closing the database connection:', err.message);
  } else {
    console.log('Database connection closed.');
  }
});
