// Pick'em HTTP API (spec §7.6 surface). Read overlay for the Live bracket cards,
// place/edit picks, leaderboard, and a profile. Mounted after global express.json.
const express = require('express');
const db = require('../db/db');
const engine = require('./engine');

const router = express.Router();

// Overlay for the bracket cards: per current market -> people's-odds split,
// the user's pick, lock state, and resolved round. Keyed by market id.
router.get('/overlay', async (req, res) => {
  try {
    const userId = Number(req.query.userId) || null;
    const markets = await db.allAsync(
      `SELECT id, player1_id, player2_id, state, round, round_text, locks_at, community_split, winner_id
       FROM set_markets WHERE state IN ('open','closed','settled')`
    );
    const pickByMarket = {};
    if (userId) {
      const mine = await db.allAsync('SELECT market_id, picked_player_id FROM pickem_picks WHERE user_id = ?', [userId]);
      for (const p of mine) pickByMarket[p.market_id] = p.picked_player_id;
    }
    const out = {};
    for (const m of markets) {
      const split = m.community_split ? JSON.parse(m.community_split) : (await engine.liveSplit(m.id)).split;
      out[m.id] = {
        round: engine.resolveRound(m),
        locked: engine.isLocked(m),
        split, // { player_id: share(0..1) } — "people's odds"
        myPick: pickByMarket[m.id] ?? null,
        winnerId: m.winner_id ?? null,
      };
    }
    res.json(out);
  } catch (err) {
    console.error('pickem overlay error:', err.message);
    res.status(500).json({ error: 'Failed to load pick\'em overlay' });
  }
});

// Place or edit a free pick (no money). Rejected once the match is locked.
router.post('/pick', async (req, res) => {
  try {
    const { userId, marketId, pickedPlayerId } = req.body || {};
    if (!userId || !marketId || !pickedPlayerId) {
      return res.status(400).json({ error: 'userId, marketId, pickedPlayerId are required' });
    }
    const r = await engine.placePick({
      userId: Number(userId), marketId: Number(marketId), pickedPlayerId: Number(pickedPlayerId),
    });
    res.json({ ok: true, ...r });
  } catch (err) {
    if (err.code === 'LOCKED') return res.status(409).json({ error: 'Picks are locked for this match' });
    res.status(400).json({ error: err.message });
  }
});

// Leaderboard for a scope (global|game|event|season). ref = '' for global.
router.get('/leaderboard', async (req, res) => {
  try {
    const scope = req.query.scope || 'global';
    const ref = req.query.ref != null ? String(req.query.ref) : '';
    const limit = Math.min(100, Number(req.query.limit) || 25);
    const rows = await db.allAsync(
      `SELECT l.user_id, COALESCE(u.display_name, u.username) AS username,
              l.points, l.correct_count, l.total_picks,
              l.current_streak, l.best_streak, u.coin_balance, u.avatar
       FROM leaderboard_entries l JOIN users u ON u.id = l.user_id
       WHERE l.scope = ? AND l.scope_ref = ?
       ORDER BY l.points DESC, l.correct_count DESC, l.total_picks ASC
       LIMIT ?`,
      [scope, ref, limit]
    );
    res.json(rows.map((r, i) => ({
      rank: i + 1, ...r, accuracy: r.total_picks ? r.correct_count / r.total_picks : 0,
    })));
  } catch (err) {
    console.error('pickem leaderboard error:', err.message);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// A user's pick'em profile: coins, points, accuracy, streaks, recent picks.
router.get('/profile', async (req, res) => {
  try {
    const userId = Number(req.query.userId);
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const g = await engine.getLeaderboardEntry(userId, 'global', '');
    const recent = await db.allAsync(
      `SELECT market_id, picked_player_id, result, points_awarded, coins_awarded, created_at
       FROM pickem_picks WHERE user_id = ? ORDER BY id DESC LIMIT 20`, [userId]
    );
    const u = await db.getAsync('SELECT COALESCE(display_name, username) AS display_name FROM users WHERE id = ?', [userId]);
    res.json({
      display_name: u ? u.display_name : null,
      coin_balance: await engine.getCoinBalance(userId),
      points: g ? g.points : 0,
      correct_count: g ? g.correct_count : 0,
      total_picks: g ? g.total_picks : 0,
      accuracy: g && g.total_picks ? g.correct_count / g.total_picks : 0,
      current_streak: g ? g.current_streak : 0,
      best_streak: g ? g.best_streak : 0,
      picks: recent,
    });
  } catch (err) {
    console.error('pickem profile error:', err.message);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;
