const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();

// Connect to the database
const db = new sqlite3.Database('./db/database.db');

// Fetch all users with plain text passwords
db.all('SELECT id, password FROM users', async (err, users) => {
  if (err) {
    console.error('Error fetching users:', err.message);
    process.exit(1);
  }

  for (const user of users) {
    // Skip if the password is already hashed
    if (user.password.startsWith('$2b$')) {
      console.log(`Password for user ID ${user.id} is already hashed.`);
      continue;
    }

    try {
      // Hash the password
      const hashedPassword = await bcrypt.hash(user.password, 10);

      // Update the user record with the hashed password
      db.run(
        'UPDATE users SET password = ? WHERE id = ?',
        [hashedPassword, user.id],
        (err) => {
          if (err) {
            console.error(`Error updating password for user ID ${user.id}:`, err.message);
          } else {
            console.log(`Password hashed successfully for user ID ${user.id}.`);
          }
        }
      );
    } catch (err) {
      console.error(`Error hashing password for user ID ${user.id}:`, err.message);
    }
  }

  console.log('Password hashing completed.');
  db.close();
});
