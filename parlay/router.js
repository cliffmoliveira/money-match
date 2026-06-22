// Futures parlay HTTP API. Stakes arrive in whole Fight Money units; the wallet
// works in cents, so convert at the edge. Mounted after global express.json.
const express = require('express');
const requireAuth = require('../auth/requireAuth');
const engine = require('./engine');

const router = express.Router();

const VALIDATION_CODES = ['TOO_FEW_LEGS', 'TOO_MANY_LEGS', 'BAD_STAKE', 'SAME_EVENT', 'LEG_UNAVAILABLE'];

// Place a parlay. Body: { stake (FM units), legs: [{ tournamentId, gameId, playerId }] }.
router.post('/', requireAuth, async (req, res) => {
  const { stake, legs } = req.body || {};
  const stakeCents = Math.round(Number(stake) * 100);
  try {
    const result = await engine.placeParlay({
      userId: req.userId,
      stakeCents,
      legs: (Array.isArray(legs) ? legs : []).map((l) => ({
        tournamentId: Number(l.tournamentId), gameId: Number(l.gameId), playerId: Number(l.playerId),
      })),
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_FUNDS') return res.status(400).json({ error: 'Not enough Fight Money for that stake.', code: err.code });
    if (VALIDATION_CODES.includes(err.code)) return res.status(400).json({ error: err.message, code: err.code });
    console.error('parlay place error:', err.message);
    res.status(500).json({ error: 'Failed to place parlay' });
  }
});

// A user's parlays (newest first), each with its legs.
router.get('/', requireAuth, async (req, res) => {
  try {
    res.json(await engine.getUserParlays(req.userId));
  } catch (err) {
    console.error('parlay list error:', err.message);
    res.status(500).json({ error: 'Failed to load parlays' });
  }
});

// Demo settle hook: grade a market's winner and settle the parlays it completes.
// (Production would drive settlement from the results pipeline, not a request.)
router.post('/settle', requireAuth, async (req, res) => {
  const { tournamentId, gameId, winnerPlayerId } = req.body || {};
  try {
    const settled = await engine.settleMarket({
      tournamentId: Number(tournamentId), gameId: Number(gameId), winnerPlayerId: Number(winnerPlayerId),
    });
    res.json({ settled });
  } catch (err) {
    console.error('parlay settle error:', err.message);
    res.status(500).json({ error: 'Failed to settle parlays' });
  }
});

module.exports = router;
