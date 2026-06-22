// Futures parlay engine. One stake rides across N outright-winner legs; the
// ticket pays stake × (product of leg odds) only if EVERY leg wins. Money moves
// through the FM wallet: debit on place, credit on an all-win settle, refund on
// a voided leg. All amounts are integer cents (1 FM = 100 cents).
const db = require('../db/db');
const wallet = require('../wallet');

const MIN_LEGS = 2;
const MAX_LEGS = 10;
const round2 = (x) => Math.round(x * 100) / 100;

// Combined decimal price = product of the legs' odds (winnings ride leg to leg).
function combinedOdds(legOdds) {
  return round2(legOdds.reduce((acc, o) => acc * o, 1));
}

// Place a futures parlay. legs = [{ tournamentId, gameId, playerId }]. Odds are
// re-priced server-side (never trust the client). Debits the stake atomically;
// throws on too few/many legs, a same-event pair, an unavailable pick, or
// insufficient funds — in every throw case NO money has moved.
async function placeParlay({ userId, stakeCents, legs }) {
  if (!Array.isArray(legs) || legs.length < MIN_LEGS) {
    const e = new Error(`A parlay needs at least ${MIN_LEGS} picks.`); e.code = 'TOO_FEW_LEGS'; throw e;
  }
  if (legs.length > MAX_LEGS) {
    const e = new Error(`A parlay can have at most ${MAX_LEGS} picks.`); e.code = 'TOO_MANY_LEGS'; throw e;
  }
  if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
    const e = new Error('Stake must be a positive amount.'); e.code = 'BAD_STAKE'; throw e;
  }
  // Guardrail: two legs from the same market (tournament+game) are mutually
  // exclusive — only one entrant wins, so the ticket could never cash.
  const marketKeys = legs.map((l) => `${l.tournamentId}:${l.gameId}`);
  if (new Set(marketKeys).size !== marketKeys.length) {
    const e = new Error("Two picks from the same event can't be combined."); e.code = 'SAME_EVENT'; throw e;
  }
  // Authoritative odds for each leg, straight from the live line.
  const priced = [];
  for (const l of legs) {
    const row = await db.getAsync(
      'SELECT live_odds FROM players_games_tournaments WHERE tournament_id = ? AND game_id = ? AND player_id = ?',
      [l.tournamentId, l.gameId, l.playerId]
    );
    if (!row || !(row.live_odds > 0)) {
      const e = new Error('One of your picks is no longer available.'); e.code = 'LEG_UNAVAILABLE'; throw e;
    }
    priced.push({ ...l, odds: row.live_odds });
  }
  const combined = combinedOdds(priced.map((p) => p.odds));

  // Debit first so an insufficient-funds bettor never creates a parlay row.
  await wallet.debit(userId, stakeCents, 'parlay_stake');
  const res = await db.runAsync(
    'INSERT INTO parlays (user_id, stake_cents, combined_odds, status) VALUES (?, ?, ?, ?)',
    [userId, stakeCents, combined, 'open']
  );
  const parlayId = res.lastID;
  for (const p of priced) {
    await db.runAsync(
      'INSERT INTO parlay_legs (parlay_id, tournament_id, game_id, player_id, leg_odds, result) VALUES (?, ?, ?, ?, ?, ?)',
      [parlayId, p.tournamentId, p.gameId, p.playerId, p.odds, 'pending']
    );
  }
  return { parlayId, combinedOdds: combined, stakeCents, legs: priced.length, payoutCents: Math.round(stakeCents * combined) };
}

// Settle a parlay once all its legs are graded: all won → credit stake×odds;
// any lost → it's already paid for. No-op if any leg is still pending.
async function settleParlayIfComplete(parlayId) {
  const p = await db.getAsync("SELECT * FROM parlays WHERE id = ? AND status = 'open'", [parlayId]);
  if (!p) return null;
  const legs = await db.allAsync('SELECT result FROM parlay_legs WHERE parlay_id = ?', [parlayId]);
  if (legs.length === 0 || legs.some((l) => l.result === 'pending')) return null;
  if (legs.some((l) => l.result === 'lost')) {
    await db.runAsync("UPDATE parlays SET status = 'lost', payout_cents = 0, settled_at = CURRENT_TIMESTAMP WHERE id = ?", [parlayId]);
    return { parlayId, status: 'lost', payoutCents: 0 };
  }
  const payoutCents = Math.round(p.stake_cents * p.combined_odds);
  await db.runAsync("UPDATE parlays SET status = 'won', payout_cents = ?, settled_at = CURRENT_TIMESTAMP WHERE id = ?", [payoutCents, parlayId]);
  await wallet.credit(p.user_id, payoutCents, 'parlay_win', { type: 'parlay', id: parlayId });
  return { parlayId, status: 'won', payoutCents };
}

// Grade every open parlay leg on a resolved market (winnerPlayerId won it), then
// settle any parlay whose legs are now fully graded.
async function settleMarket({ tournamentId, gameId, winnerPlayerId }) {
  await db.runAsync(
    `UPDATE parlay_legs SET result = CASE WHEN player_id = ? THEN 'won' ELSE 'lost' END
     WHERE tournament_id = ? AND game_id = ? AND result = 'pending'
       AND parlay_id IN (SELECT id FROM parlays WHERE status = 'open')`,
    [winnerPlayerId, tournamentId, gameId]
  );
  const affected = await db.allAsync(
    `SELECT DISTINCT pl.parlay_id FROM parlay_legs pl JOIN parlays p ON p.id = pl.parlay_id
     WHERE pl.tournament_id = ? AND pl.game_id = ? AND p.status = 'open'`,
    [tournamentId, gameId]
  );
  const settled = [];
  for (const { parlay_id } of affected) {
    const r = await settleParlayIfComplete(parlay_id);
    if (r) settled.push(r);
  }
  return settled;
}

// Void a market (e.g. a no-contest): every open parlay touching it is refunded
// its full stake and closed. (v1: refund the whole ticket rather than re-pricing.)
async function voidMarket({ tournamentId, gameId }) {
  const affected = await db.allAsync(
    `SELECT DISTINCT pl.parlay_id FROM parlay_legs pl JOIN parlays p ON p.id = pl.parlay_id
     WHERE pl.tournament_id = ? AND pl.game_id = ? AND p.status = 'open'`,
    [tournamentId, gameId]
  );
  const voided = [];
  for (const { parlay_id } of affected) {
    const p = await db.getAsync("SELECT * FROM parlays WHERE id = ? AND status = 'open'", [parlay_id]);
    if (!p) continue;
    await db.runAsync("UPDATE parlay_legs SET result = 'void' WHERE parlay_id = ? AND tournament_id = ? AND game_id = ?", [parlay_id, tournamentId, gameId]);
    await db.runAsync("UPDATE parlays SET status = 'void', payout_cents = ?, settled_at = CURRENT_TIMESTAMP WHERE id = ?", [p.stake_cents, parlay_id]);
    await wallet.credit(p.user_id, p.stake_cents, 'parlay_refund', { type: 'parlay', id: parlay_id });
    voided.push({ parlayId: parlay_id, refundCents: p.stake_cents });
  }
  return voided;
}

// A user's parlays with their legs, newest first (for display).
async function getUserParlays(userId, limit = 20) {
  const parlays = await db.allAsync('SELECT * FROM parlays WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit]);
  for (const p of parlays) {
    p.legs = await db.allAsync(
      'SELECT tournament_id, game_id, player_id, leg_odds, result FROM parlay_legs WHERE parlay_id = ? ORDER BY id',
      [p.id]
    );
  }
  return parlays;
}

module.exports = {
  MIN_LEGS, MAX_LEGS, combinedOdds,
  placeParlay, settleMarket, settleParlayIfComplete, voidMarket, getUserParlays,
};
