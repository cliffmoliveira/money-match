const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');
const db = require('./db/db'); // Your database connection module
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const secretKey = 'your_secret_key'; // Use an environment variable in production
const { syncTournamentBySlug, syncRecent } = require('./syncStartgg');
const { syncUpcoming, syncRecentResults } = require('./scripts/sync-upcoming');
const wallet = require('./wallet');
const liveMarkets = require('./liveMarkets');
const { syncLive } = require('./scripts/sync-live');
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
// Affiliate attribution loop — mounted BEFORE the global express.json so the
// router's own body parsers run: express.json() on /click, and express.raw() on
// /postback (which must read the exact raw bytes to verify the HMAC before
// parsing). Self-contained; shares no state with the rest of the app.
app.use('/api/affiliate', require('./affiliate/router'));
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies
app.use('/api/pickem', require('./pickem/router'));
app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'client', 'build')));

// Password reset (forgot-password / reset-password) — uses the global express.json above.
app.use('/api/auth', require('./auth/passwordReset'));

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

    // Grant the new user a starting play-money balance via the wallet ledger.
    try {
      await wallet.credit(result.lastID, wallet.STARTING_GRANT_CENTS, 'grant');
    } catch (grantErr) {
      console.error('Failed to grant starting balance:', grantErr.message);
    }

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
        tournaments.logo_url AS logoUrl,
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
      WHERE tournaments.date <= DATE('now', '+30 days')
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
        id,
        name,
        date,
        city,
        country,
        logo_url AS logoUrl
      FROM tournaments
      WHERE date >= DATE('now')
      ORDER BY date ASC;
    `;
    const tournaments = await db.allAsync(query);

    // Format the response to match the expected structure
    const formattedTournaments = tournaments.map(t => ({
      id: t.id,
      name: t.name,
      date: t.date,
      logoUrl: t.logoUrl,
      location: { city: t.city, country: t.country }
    }));

    res.json(formattedTournaments);
  } catch (err) {
    console.error('Error fetching tournaments:', err.message);
    res.status(500).json({ error: 'Failed to fetch tournaments.' });
  }
});

app.get('/api/tournaments/all', async (req, res) => {
  try {
    const tournaments = await db.allAsync('SELECT id, name FROM tournaments');
    res.json(tournaments);
  } catch (err) {
    console.error('Error fetching all tournaments:', err.message);
    res.status(500).json({ error: 'Failed to fetch all tournaments.' });
  }
});


app.get('/api/games', async (req, res) => {
  try {
    const games = await db.allAsync('SELECT id, name FROM games');
    res.json(games);
  } catch (err) {
    console.error('Error fetching games:', err);
    res.status(500).json({ error: 'Failed to fetch games.' });
  }
});

app.get('/api/players', async (req, res) => {
  try {
    const players = await db.allAsync('SELECT id, name FROM players');
    res.json(players);
  } catch (err) {
    console.error('Error fetching players:', err);
    res.status(500).json({ error: 'Failed to fetch players.' });
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
          b.tournament_id,
          b.game_id,
          b.player_id,
          b.amount,
          b.locked_odds,
          CASE
            WHEN m.winner_id IS NULL THEN NULL -- Pending
            -- "The Field" bet wins when the champion isn't one of the listed seeds.
            WHEN p.name = 'The Field' THEN
              CASE WHEN EXISTS (
                SELECT 1 FROM players_games_tournaments pgt
                WHERE pgt.tournament_id = b.tournament_id
                  AND pgt.game_id = b.game_id
                  AND pgt.player_id = m.winner_id
              ) THEN 0 ELSE 1 END
            WHEN m.winner_id = b.player_id THEN 1 -- Win
            ELSE 0 -- Loss
          END AS is_winner
       FROM bets b
       JOIN players p ON p.id = b.player_id
       LEFT JOIN matches m ON b.tournament_id = m.tournament_id AND b.game_id = m.game_id
       WHERE b.user_id = ?`,
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
      // Blend the delta: the portion of stake the bettor already had keeps its
      // original locked odds; only the *added* stake locks at the current odds.
      // We store the weighted-average odds in the single row, so that
      // amount * locked_odds == kept_stake*old_odds + added_stake*current_odds —
      // mathematically identical to holding separate tickets, without a schema
      // change. Reducing a stake keeps the existing blended odds.
      const existing = await db.getAsync(
        `SELECT amount, locked_odds FROM bets
         WHERE user_id = ? AND tournament_id = ? AND game_id = ? AND player_id = ?`,
        [userId, tournamentId, gameId, playerId]
      );
      const oldAmount = existing ? existing.amount : 0;
      const oldOdds = existing ? existing.locked_odds : 0;
      const kept = Math.min(amount, oldAmount);
      const added = Math.max(0, amount - oldAmount);
      const blendedOdds = (kept * oldOdds + added * live_odds) / amount;

      // Insert or Update Bet
      await db.runAsync(
        `INSERT INTO bets (user_id, tournament_id, game_id, player_id, amount, locked_odds)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, tournament_id, game_id, player_id)
         DO UPDATE SET amount = excluded.amount, locked_odds = excluded.locked_odds, updated_at = CURRENT_TIMESTAMP`,
        [userId, tournamentId, gameId, playerId, amount, blendedOdds]
      );
    } else {
      // Delete Bet
      await db.runAsync(
        `DELETE FROM bets 
         WHERE user_id = ? AND tournament_id = ? AND game_id = ? AND player_id = ?`,
        [userId, tournamentId, gameId, playerId]
      );
    }

    // Futures odds are fixed seed-based lines (set by the sync), so they no
    // longer move with the pool — each bet just locks the current odds.

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
          pgt.seed_num,
          pgt.win_probability,
          pgt.live_odds,
          COALESCE(SUM(b.amount), 0) AS total_amount,
          COUNT(b.id) AS total_bets
       FROM players_games_tournaments pgt
       JOIN players p ON p.id = pgt.player_id
       LEFT JOIN bets b ON pgt.tournament_id = b.tournament_id
                        AND pgt.game_id = b.game_id
                        AND pgt.player_id = b.player_id
       WHERE pgt.tournament_id = ? AND pgt.game_id = ?
       GROUP BY pgt.player_id, p.name, pgt.seed_num, pgt.win_probability, pgt.live_odds
       ORDER BY (pgt.seed_num IS NULL), pgt.seed_num`,
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

// Wallet: balance + recent transactions
app.get('/api/wallet', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  try {
    const balanceCents = await wallet.getBalance(userId);
    if (balanceCents === null) return res.status(404).json({ error: 'User not found' });
    const transactions = await wallet.getTransactions(userId);
    res.json({ balanceCents, transactions });
  } catch (err) {
    console.error('Error fetching wallet:', err.message);
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

// Deposit (play-money top-up): credit the wallet and return the new balance.
// Mirrors the /api/wallet read + wallet.js ledger logic.
app.post('/api/wallet/deposit', async (req, res) => {
  const { userId, amountCents } = req.body || {};
  const amount = Number(amountCents);
  if (!userId || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'userId and a positive integer amountCents are required' });
  }
  try {
    // Guard against crediting a non-existent user, which would otherwise write a
    // phantom ledger row and return balanceCents:null. Mirrors the 404 the
    // /api/wallet read returns for an unknown user.
    const current = await wallet.getBalance(Number(userId));
    if (current === null) {
      return res.status(404).json({ error: 'User not found' });
    }
    const balanceCents = await wallet.credit(Number(userId), amount, 'deposit');
    res.status(201).json({ balanceCents });
  } catch (err) {
    console.error('Deposit failed:', err.message);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

// Live per-set betting
app.get('/api/live/markets', async (req, res) => {
  try {
    const includeAll = req.query.all === '1';
    const markets = await liveMarkets.getMarkets({ includeAll });
    res.json(markets);
  } catch (err) {
    console.error('Error fetching live markets:', err.message);
    res.status(500).json({ error: 'Failed to fetch live markets' });
  }
});

app.get('/api/live/bets', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  try {
    const bets = await liveMarkets.getUserBets(userId);
    res.json(bets);
  } catch (err) {
    console.error('Error fetching live bets:', err.message);
    res.status(500).json({ error: 'Failed to fetch live bets' });
  }
});

// Read-only: the next tracked tournament + its games, for the Live page's
// pre-Top-8 "waiting room". No auth, no writes.
app.get('/api/live/upcoming', async (req, res) => {
  try {
    res.json(await liveMarkets.getUpcoming());
  } catch (err) {
    console.error('Error fetching upcoming tournament:', err.message);
    res.status(500).json({ error: 'Failed to fetch upcoming tournament' });
  }
});

// Demo tools: seed markets and simulate set outcomes without a real event.
// Off by default; enable with ENABLE_DEMO=1. Remove/keep gated before any
// real-money launch.
const DEMO_ENABLED = process.env.ENABLE_DEMO === '1';
const requireDemo = (req, res, next) =>
  DEMO_ENABLED ? next() : res.status(403).json({ error: 'Demo tools are disabled' });

app.get('/api/config', (req, res) => {
  res.json({ demoEnabled: DEMO_ENABLED });
});

app.post('/api/live/seed-demo', requireDemo, async (req, res) => {
  try {
    const result = await liveMarkets.seedDemoMarkets();
    res.json(result);
  } catch (err) {
    console.error('Seed demo failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/live/demo/reset', requireDemo, async (req, res) => {
  try {
    const result = await liveMarkets.clearDemoMarkets();
    res.json(result);
  } catch (err) {
    console.error('Demo reset failed:', err.message);
    res.status(500).json({ error: 'Failed to reset demo' });
  }
});

app.post('/api/live/demo/close', requireDemo, async (req, res) => {
  const { marketId } = req.body || {};
  if (!marketId) return res.status(400).json({ error: 'marketId is required' });
  try {
    await liveMarkets.closeMarket(Number(marketId));
    res.json({ ok: true });
  } catch (err) {
    console.error('Demo close failed:', err.message);
    res.status(500).json({ error: 'Failed to close market' });
  }
});

app.post('/api/live/demo/settle', requireDemo, async (req, res) => {
  const { marketId, winnerId } = req.body || {};
  if (!marketId || !winnerId) return res.status(400).json({ error: 'marketId and winnerId are required' });
  try {
    await liveMarkets.settleMarket(Number(marketId), Number(winnerId));
    // Demo bracket: push the winner into the next round if both feeders are in.
    const m = await db.getAsync('SELECT tournament_id, game_id FROM set_markets WHERE id = ?', [Number(marketId)]);
    if (m) await liveMarkets.advanceDemoBracket(m.tournament_id, m.game_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Demo settle failed:', err.message);
    res.status(500).json({ error: 'Failed to settle market' });
  }
});

// Manually trigger the live poller, optionally flagging a tournament live first.
app.post('/api/live/sync', async (req, res) => {
  const { tournamentId, isLive } = req.body || {};
  try {
    if (tournamentId !== undefined && isLive !== undefined) {
      await db.runAsync('UPDATE tournaments SET is_live = ? WHERE id = ?', [isLive ? 1 : 0, tournamentId]);
    }
    const result = await syncLive({});
    res.json(result);
  } catch (err) {
    console.error('Live sync failed:', err.message);
    res.status(500).json({ error: 'Live sync failed' });
  }
});

app.post('/api/live/bets', async (req, res) => {
  const { userId, marketId, playerId, amountCents } = req.body || {};
  if (!userId || !marketId || !playerId || amountCents === undefined) {
    return res.status(400).json({ error: 'userId, marketId, playerId, amountCents are required' });
  }
  try {
    const result = await liveMarkets.placeBet({
      userId: Number(userId), marketId: Number(marketId),
      playerId: Number(playerId), amountCents: Number(amountCents),
    });
    res.status(201).json(result);
  } catch (err) {
    const map = {
      INSUFFICIENT_FUNDS: [402, 'Insufficient balance'],
      MARKET_CLOSED: [409, 'Market is no longer open for betting'],
      NOT_FOUND: [404, 'Market not found'],
      BAD_PLAYER: [400, 'Player is not in this market'],
      BAD_AMOUNT: [400, 'Invalid bet amount'],
    };
    const [code, msg] = map[err.code] || [500, 'Failed to place bet'];
    if (code === 500) console.error('Error placing live bet:', err.message);
    res.status(code).json({ error: msg });
  }
});

// Sync endpoints
app.post('/api/sync/startgg/tournament', async (req, res) => {
  try {
    const { slug } = req.body || {};
    if (!slug) return res.status(400).json({ error: 'Missing slug' });
    const token = req.headers['x-startgg-token'];
    const result = await syncTournamentBySlug(slug, token);
    res.json(result);
  } catch (err) {
    console.error('StartGG sync error:', err.message);
    res.status(500).json({ error: 'Failed to sync tournament', details: err.message });
  }
});

app.post('/api/sync/startgg/recent', async (req, res) => {
  try {
    const { afterDate, beforeDate, perPage, maxPages } = req.body || {};
    if (!afterDate || !beforeDate) {
      return res.status(400).json({ error: 'Missing afterDate or beforeDate (unix timestamps)' });
    }
    const token = req.headers['x-startgg-token'];
    const result = await syncRecent({ after: afterDate, before: beforeDate, perPage, maxPages }, token);
    res.json(result);
  } catch (err) {
    console.error('StartGG sync recent error:', err.message);
    res.status(500).json({ error: 'Failed to sync recent', details: err.message });
  }
});


// Daily scheduler: refresh upcoming major tournaments (+ their seeds) for the
// Future Tournaments page, and record recently-completed major results for the
// Past Results page. Both are curated to major brands, so each run is light.
function scheduleStartGgSync() {
  const token = process.env.STARTGG_API_TOKEN || null;
  if (!token) {
    console.warn('STARTGG_API_TOKEN not set; Start.gg auto-sync is disabled.');
    return;
  }
  const runSync = async () => {
    try {
      await syncUpcoming({ months: 12, top: 16 });
    } catch (err) {
      console.error('Start.gg upcoming sync failed:', err.message);
    }
    try {
      await syncRecentResults({ days: 30 });
    } catch (err) {
      console.error('Start.gg recent-results sync failed:', err.message);
    }
  };
  // Run once on server start, then every 24 hours.
  runSync();
  setInterval(runSync, 24 * 60 * 60 * 1000);
}

// Live poller: refresh Top 8 markets for active tournaments every 60s. Cheap
// when nothing is live (one local query, no Start.gg call).
function scheduleLiveSync() {
  const run = async () => {
    try { await syncLive({}); }
    catch (err) { console.error('Live sync error:', err.message); }
  };
  run();
  setInterval(run, 60 * 1000);
}

// Kick off schedulers (skippable for tests via DISABLE_SYNC=1)
if (!process.env.DISABLE_SYNC) {
  scheduleStartGgSync();
  scheduleLiveSync();
}

// Catch-all route for React
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'build', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
