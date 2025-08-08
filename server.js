const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const db = require('./db/db'); // Your database connection module
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const secretKey = 'your_secret_key'; // Use an environment variable in production
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies
app.use(express.static(path.join(__dirname, 'client', 'build')));

// API Routes 
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const query = 'SELECT id, username, password FROM users WHERE email = ?';
    const user = await db.getAsync(query, [email]);

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign({ id: user.id }, secretKey, { expiresIn: '1h' });

    res.status(200).json({
      message: 'Login successful',
      token,
      userId: user.id,
      username: user.username, // Ensure username is sent in the response
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


app.post('/api/auth/signup', async (req, res) => {
  const { username, email, password } = req.body;

  console.log('Incoming signup request:', { username, email });

  // Validate input
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    // Check if the email already exists
    const checkQuery = 'SELECT * FROM users WHERE email = ?';
    const existingUser = await db.getAsync(checkQuery, [email]);

    if (existingUser) {
      return res.status(409).json({ error: 'Email already in use.' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Insert the new user into the database
    const insertQuery = `
      INSERT INTO users (username, email, password)
      VALUES (?, ?, ?)
    `;
    const result = await db.runAsync(insertQuery, [username, email, hashedPassword]);

    console.log('User created successfully:', { id: result.lastID, username, email });

    res.status(201).json({
      message: 'Account created successfully',
      userId: result.lastID,
    });
  } catch (err) {
    console.error('Error creating user:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = {
      userCount: 100,
      activeMatches: 5,
    };
    res.json(stats);
  } catch (err) {
    console.error('Error fetching stats:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Endpoint: Get past results
app.get('/api/past-results', async (req, res) => {
  try {
    const query = `
      SELECT 
        matches.id, 
        tournaments.name AS tournament, 
        tournaments.date, 
        tournaments.city AS city, 
        tournaments.country AS country, 
        games.name AS game, 
        player1.name AS winner, 
        player2.name AS loser, 
        matches.player1RoundsWon AS winnerRoundsWon, 
        matches.player2RoundsWon AS loserRoundsWon
      FROM matches
      JOIN players AS player1 ON matches.winner_id = player1.id
      JOIN players AS player2 ON matches.loser_id = player2.id
      JOIN tournaments ON matches.tournament_id = tournaments.id
      JOIN games ON matches.game_id = games.id
      WHERE tournaments.date < DATE('now')
      ORDER BY tournaments.date DESC;
    `;
    const results = await db.allAsync(query);
    res.json({ data: results });
  } catch (err) {
    console.error('Error fetching past results:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to fetch past results.' });
  }
});


// Endpoint: Get future tournaments
app.get('/api/tournaments', async (req, res) => {
  try {
    const query = `
      SELECT 
        t.id AS tournament_id,
        t.name AS tournament_name,
        t.date,
        t.city,
        t.country,
        g.id AS game_id,
        g.name AS game_name,
        p.id AS player_id,
        p.name AS player_name
      FROM tournaments t
      LEFT JOIN players_games_tournaments pgt ON t.id = pgt.tournament_id
      LEFT JOIN games g ON pgt.game_id = g.id
      LEFT JOIN players p ON pgt.player_id = p.id
      WHERE t.date >= DATE('now')
      ORDER BY t.date ASC;
    `;
    const rows = await db.allAsync(query);

    const tournaments = rows.reduce((acc, row) => {
      const tournament = acc[row.tournament_id] || {
        id: row.tournament_id,
        name: row.tournament_name,
        date: row.date,
        location: { city: row.city, country: row.country },
        games: {},
      };

      if (row.game_id && row.game_name) {
        const game = tournament.games[row.game_id] || {
          id: row.game_id,
          name: row.game_name,
          players: [],
        };

        if (row.player_id && row.player_name) {
          game.players.push({ id: row.player_id, name: row.player_name });
        }

        tournament.games[row.game_id] = game;
      }

      acc[row.tournament_id] = tournament;
      return acc;
    }, {});

    res.json(Object.values(tournaments));
  } catch (err) {
    console.error('Error fetching tournaments:', err.message);
    res.status(500).json({ error: 'Failed to fetch tournaments.' });
  }
});


app.get('/api/tournament/:tournamentId/games', async (req, res) => {
  const { tournamentId } = req.params;

  try {
    console.log('Fetching games for tournamentId:', tournamentId);

    const games = await db.allAsync(
      `SELECT DISTINCT g.id AS game_id, g.name AS game_name 
       FROM games g
       JOIN players_games_tournaments pgt ON g.id = pgt.game_id
       WHERE pgt.tournament_id = ?`,
      [tournamentId]
    );

    if (!games || games.length === 0) {
      return res.status(404).json({ error: 'No games found for this tournament' });
    }

    console.log('Fetched Games:', games);
    res.status(200).json(games);
  } catch (err) {
    console.error('Error fetching tournament games:', err.message);
    res.status(500).json({ error: 'Failed to fetch tournament games', details: err.message });
  }
});


// Endpoint: Get games
app.get('/api/games', async (req, res) => {
  try {
    const games = await db.allAsync('SELECT * FROM games');
    res.json(Object.values(games));
  } catch (err) {
    console.error('Error fetching games:', err);
    res.status(500).json({ error: 'Failed to fetch games.' });
  }
});

app.get('/api/game/totals', async (req, res) => {
  const { tournamentId, gameId } = req.query;

  try {
    const totals = await db.allAsync(
      `SELECT 
          player_id,
          COUNT(*) AS total_bets,
          SUM(amount) AS total_amount
       FROM bets
       WHERE tournament_id = ? AND game_id = ?
       GROUP BY player_id`,
      [tournamentId, gameId]
    );

    res.status(200).json(totals);
  } catch (err) {
    console.error('Error fetching totals:', err.message);
    res.status(500).json({ error: 'Failed to fetch totals', details: err.message });
  }
});

// Endpoint: Get players
app.get('/api/players', async (req, res) => {
  try {
    const players = await db.allAsync('SELECT * FROM players');
    res.json(Object.values(players));
  } catch (err) {
    console.error('Error fetching players:', err);
    res.status(500).json({ error: 'Failed to fetch players.' });
  }
});

// ✅ GET /api/bets - Fetch user bets
app.get('/api/bets', async (req, res) => {
  const { userId } = req.query;

  try {
    const bets = await db.allAsync(
      `SELECT 
          tournament_id, 
          game_id, 
          player_id, 
          amount, 
          locked_odds 
       FROM bets 
       WHERE user_id = ?`,
      [userId]
    );

    res.status(200).json(bets);
  } catch (err) {
    console.error('Error fetching bets:', err.message);
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});


// Endpoint: Submit or Update a Bet
app.post('/api/bets', async (req, res) => {
  const { userId, tournamentId, gameId, playerId, amount } = req.body;

  console.log('Incoming Bet Payload:', {
    userId,
    tournamentId,
    gameId,
    playerId,
    amount,
  });

  try {
    if (!userId || !tournamentId || !gameId || !playerId || amount === undefined) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    // Fetch current live odds
    const oddsResult = await db.getAsync(
      `SELECT live_odds FROM players_games_tournaments 
       WHERE tournament_id = ? AND game_id = ? AND player_id = ?`,
      [tournamentId, gameId, playerId]
    );

    if (!oddsResult) {
      return res.status(400).json({ error: 'Player odds not found.' });
    }

    const { live_odds } = oddsResult;

    if (amount > 0) {
      // Insert or Update Bet
      await db.runAsync(
        `INSERT INTO bets (user_id, tournament_id, game_id, player_id, amount, locked_odds)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, tournament_id, game_id, player_id)
         DO UPDATE SET amount = excluded.amount, locked_odds = excluded.locked_odds, updated_at = CURRENT_TIMESTAMP`,
        [userId, tournamentId, gameId, playerId, amount, live_odds]
      );
    } else {
      // Delete Bet
      await db.runAsync(
        `DELETE FROM bets 
         WHERE user_id = ? AND tournament_id = ? AND game_id = ? AND player_id = ?`,
        [userId, tournamentId, gameId, playerId]
      );
    }

    // Recalculate live odds for all players in the same game
    await db.runAsync(
      `UPDATE players_games_tournaments
       SET live_odds = CASE 
         WHEN (SELECT COALESCE(SUM(amount), 0) 
               FROM bets 
               WHERE tournament_id = players_games_tournaments.tournament_id 
                 AND game_id = players_games_tournaments.game_id) > 0 THEN 
           (SELECT SUM(amount) 
            FROM bets 
            WHERE tournament_id = players_games_tournaments.tournament_id 
              AND game_id = players_games_tournaments.game_id) 
           / (SELECT COALESCE(SUM(amount), 1) 
              FROM bets 
              WHERE tournament_id = players_games_tournaments.tournament_id 
                AND game_id = players_games_tournaments.game_id 
                AND player_id = players_games_tournaments.player_id)
           * 0.95
         ELSE 1.0
       END
       WHERE tournament_id = ? AND game_id = ?`,
      [tournamentId, gameId]
    );

    res.status(200).json({ message: 'Bet saved successfully' });
  } catch (err) {
    console.error('Error saving bet:', err.message);
    res.status(500).json({ error: 'Failed to save bet', details: err.message });
  }
});

// Endpoint: Fetch Dynamic Bet Details for a Game
app.get('/api/game/:tournamentId/:gameId/players', async (req, res) => {
  const { tournamentId, gameId } = req.params;

  try {
    const playersData = await db.allAsync(
      `SELECT 
          pgt.player_id,
          p.name AS player_name,
          pgt.live_odds,
          COALESCE(SUM(b.amount), 0) AS total_amount,
          COUNT(b.id) AS total_bets
       FROM players_games_tournaments pgt
       JOIN players p ON p.id = pgt.player_id
       LEFT JOIN bets b ON pgt.tournament_id = b.tournament_id 
                        AND pgt.game_id = b.game_id 
                        AND pgt.player_id = b.player_id
       WHERE pgt.tournament_id = ? AND pgt.game_id = ?
       GROUP BY pgt.player_id, p.name, pgt.live_odds`,
      [tournamentId, gameId]
    );

    res.status(200).json(playersData);
  } catch (err) {
    console.error('Error fetching game players:', err.message);
    res.status(500).json({ error: 'Failed to fetch players', details: err.message });
  }
});



app.delete('/api/bets', async (req, res) => {
  const { userId, tournamentId, gameId } = req.body;

  if (!userId || !tournamentId || !gameId) {
    return res.status(400).json({ error: 'Missing required fields: userId, tournamentId, or gameId' });
  }

  try {
    await db.runAsync(
      'DELETE FROM bets WHERE user_id = ? AND tournament_id = ? AND game_id = ?',
      [userId, tournamentId, gameId]
    );

    res.status(200).json({ message: 'Bet deleted successfully' });
  } catch (err) {
    console.error('Error deleting bet:', err.message);
    res.status(500).json({ error: 'Failed to delete bet' });
  }
});

app.post('/api/bets/outcome', async (req, res) => {
  const { userId, tournamentId, gameId, playerId, isWinner } = req.body;

  try {
    if (
      !userId ||
      !tournamentId ||
      !gameId ||
      !playerId ||
      (isWinner !== 0 && isWinner !== 1)
    ) {
      return res.status(400).json({ error: 'All fields are required, and isWinner must be 0 or 1.' });
    }

    await db.runAsync(
      `UPDATE bets 
       SET is_winner = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND tournament_id = ? AND game_id = ? AND player_id = ?`,
      [isWinner, userId, tournamentId, gameId, playerId]
    );

    res.status(200).json({ message: 'Bet outcome updated successfully' });
  } catch (err) {
    console.error('Error updating bet outcome:', err.message);
    res.status(500).json({ error: 'Failed to update bet outcome', details: err.message });
  }
});


// Catch-all route for React
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'build', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
