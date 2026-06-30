/**
 * Live per-set betting markets: lifecycle (open -> closed -> settled/void),
 * bet placement against the wallet, and settlement. Pure odds math lives in
 * liveOdds.js; money movement goes through wallet.js.
 */
const db = require('./db/db');
const wallet = require('./wallet');
const economy = require('./economy');
const { withWriteTx } = require('./txn');
const { openingProbabilities, computeLiveOdds, effectiveSubsidyCents, RAKE, round2 } = require('./liveOdds');

const TBD = 0; // player id placeholder for an unfilled bracket slot

// ---- House bankroll + per-side pricing (scaled subsidy, rake-funded cap) ----

// Virtual-currency marketing budget the house is willing to risk. 0 => the house can
// never go net-negative; raise it to let the subsidy juice odds before any rake
// has accumulated (the platform's worst-case net is then -this).
const HOUSE_PROMO_SEED_CENTS = 0;

// The house's cumulative take from settled live bets (stakes kept minus payouts
// made), plus the promo seed. The subsidy boost on any market may draw from this
// but never exceed it, so the platform balance stays >= 0 at all times.
//
// This value only changes when bets move to/from won/lost (settlement, void,
// demo reset) — never on placement. recomputeOdds runs on every bet, so without
// caching this would scan the whole ledger per bet during a burst. We memoize it
// and invalidate whenever those states change, so a betting burst reads it for
// free and the underlying scan runs at most once per settlement.
let _bankrollCache = null;
function invalidateBankrollCache() { _bankrollCache = null; }
async function houseBankrollCents() {
  if (_bankrollCache !== null) return _bankrollCache;
  const row = await db.getAsync(
    `SELECT COALESCE(SUM(amount_cents), 0) - COALESCE(SUM(payout_cents), 0) AS net
     FROM set_bets WHERE state IN ('won', 'lost')`
  );
  _bankrollCache = HOUSE_PROMO_SEED_CENTS + (row?.net || 0);
  return _bankrollCache;
}

// Decimal payout price for each side given the current pools and house bankroll.
// Starts from the scaled-subsidy parimutuel line, then clamps each side into
// [strict pool-only price, strict + subsidy the bankroll can fund] so that:
//   • a winner is never paid less than a pure parimutuel split, and
//   • the house never pays out subsidy money it hasn't already earned in rake.
// Returns rounded odds for both sides plus the effective subsidy used.
function sideRates(market, bankrollCents) {
  const p1Pool = market.p1_pool_cents || 0;
  const p2Pool = market.p2_pool_cents || 0;
  const pool = p1Pool + p2Pool;
  const kEff = effectiveSubsidyCents(pool);
  const { p1Odds, p2Odds } = computeLiveOdds({
    p1Prob: market.p1_prob, p2Prob: market.p2_prob, seedKCents: kEff,
    p1PoolCents: p1Pool, p2PoolCents: p2Pool,
  });
  const bank = Math.max(0, bankrollCents || 0);
  const priceSide = (sidePool, subsidyRate) => {
    if (sidePool <= 0) return round2(subsidyRate); // no stake yet -> show the projected line
    const strictRate = (pool * (1 - RAKE)) / sidePool; // pure pool split (house always keeps the rake)
    const cappedRate = strictRate + bank / sidePool;   // + as much subsidy as the bankroll can fund
    return round2(Math.min(Math.max(subsidyRate, strictRate), cappedRate));
  };
  return { p1: priceSide(p1Pool, p1Odds), p2: priceSide(p2Pool, p2Odds), kEff };
}

// ---- Market lifecycle (used by the poller) ----

/**
 * Ensure an "open" market exists for a set. Idempotent by startgg_set_id.
 * Only call when both entrants are real players.
 */
async function ensureOpenMarket({
  tournamentId, gameId, startggSetId, roundText,
  player1Id, player2Id, seed1, seed2, p1WinnersSide, p2WinnersSide,
  roundInt = null, phaseGroupId = null,
}) {
  const existing = await db.getAsync('SELECT id, state FROM set_markets WHERE startgg_set_id = ?', [startggSetId]);
  if (existing) return existing.id;

  const kEff = effectiveSubsidyCents(0); // empty pool at open -> the subsidy floor
  const { p1, p2 } = openingProbabilities(seed1, seed2, p1WinnersSide, p2WinnersSide);
  const { p1Odds, p2Odds } = computeLiveOdds({ p1Prob: p1, p2Prob: p2, seedKCents: kEff });
  const res = await db.runAsync(
    `INSERT INTO set_markets
       (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_group_id,
        player1_id, player2_id, p1_seed, p2_seed, state, p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    [tournamentId, gameId, startggSetId, roundText || null, roundInt, phaseGroupId,
     player1Id, player2Id, seed1 ?? null, seed2 ?? null, p1, p2, kEff, p1Odds, p2Odds]
  );
  return res.lastID;
}

/**
 * Fill one slot of a bracket node, creating it as a half-filled "pending" market
 * if it doesn't exist yet. As soon as both slots hold real players the market is
 * priced and flipped to "open". This lets a winner appear in the next round
 * immediately, before the opposing feeder set finishes. `slot` is 1 or 2.
 */
async function fillBracketSlot({
  tournamentId, gameId, startggSetId, roundText, roundInt = null, phaseGroupId = null,
  slot, playerId, seed = null,
}) {
  if (!playerId) return;

  // Void any lingering preview_* projection for this player in this tournament
  // now that their real set is known. Projected markets have synthetic set IDs;
  // keeping them open alongside the real set creates duplicate bracket cards.
  if (!startggSetId.startsWith('preview_')) {
    await db.runAsync(
      `UPDATE set_markets SET state='void'
       WHERE tournament_id = ? AND startgg_set_id LIKE 'preview_%'
         AND state NOT IN ('settled','void')
         AND (player1_id = ? OR player2_id = ?)`,
      [tournamentId, playerId, playerId]
    );
  }

  // Don't advance a player who still has an active (open/closed) match in this
  // tournament. Start.gg pre-populates next-round slots based on seeding before
  // feeder sets finish; without this guard a player appears in two live markets.
  const stillActive = await db.getAsync(
    `SELECT id FROM set_markets
     WHERE tournament_id = ? AND state IN ('open', 'closed')
       AND (player1_id = ? OR player2_id = ?)
       AND startgg_set_id != ?`,
    [tournamentId, playerId, playerId, startggSetId]
  );
  if (stillActive) return;

  const existing = await db.getAsync('SELECT * FROM set_markets WHERE startgg_set_id = ?', [startggSetId]);

  if (!existing) {
    await db.runAsync(
      `INSERT INTO set_markets
         (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_group_id,
          player1_id, player2_id, p1_seed, p2_seed, state, p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0.5, 0.5, ?, 0, 0)`,
      [tournamentId, gameId, startggSetId, roundText || null, roundInt, phaseGroupId,
       slot === 1 ? playerId : TBD, slot === 2 ? playerId : TBD,
       slot === 1 ? seed : null, slot === 2 ? seed : null, effectiveSubsidyCents(0)]
    );
    return;
  }
  if (existing.state === 'settled') return;
  if (existing.state === 'void') {
    // Void markets can be re-used when a bracket re-seeds or an opponent was
    // entered late. Reset to blank-pending so the slot updates below re-fill it
    // and the market opens normally once both players are known.
    await db.runAsync(
      `UPDATE set_markets SET state='pending', player1_id=0, player2_id=0,
       p1_seed=NULL, p2_seed=NULL, winner_id=NULL, settled_at=NULL,
       p1_prob=0.5, p2_prob=0.5, p1_live_odds=0, p2_live_odds=0,
       round_text=COALESCE(?,round_text), round_int=COALESCE(?,round_int) WHERE id=?`,
      [roundText ?? null, roundInt ?? null, existing.id]
    );
  }

  const idCol = slot === 1 ? 'player1_id' : 'player2_id';
  const seedCol = slot === 1 ? 'p1_seed' : 'p2_seed';
  await db.runAsync(`UPDATE set_markets SET ${idCol} = ?, ${seedCol} = ? WHERE id = ?`, [playerId, seed, existing.id]);

  // Both slots real and still pending -> price it and open for betting.
  const m = await db.getAsync('SELECT * FROM set_markets WHERE id = ?', [existing.id]);
  if (m.state === 'pending' && m.player1_id && m.player1_id !== TBD && m.player2_id && m.player2_id !== TBD) {
    // Winners-side edge is a Grand Final concept (the undefeated entrant — slot 1
    // — is favored). Derive it from the round here so pricing doesn't depend on
    // which slot happened to fill second.
    const p1WinnersSide = /grand final/.test((m.round_text || '').toLowerCase());
    const { p1, p2 } = openingProbabilities(m.p1_seed, m.p2_seed, p1WinnersSide, false);
    const { p1Odds, p2Odds } = computeLiveOdds({ p1Prob: p1, p2Prob: p2, seedKCents: m.seed_k_cents });
    await db.runAsync(
      `UPDATE set_markets SET state='open', p1_prob=?, p2_prob=?, p1_live_odds=?, p2_live_odds=? WHERE id=?`,
      [p1, p2, p1Odds, p2Odds, existing.id]
    );
  }
}

/** Set in progress -> stop taking bets. Optionally write mid-match scores (updates on every poll). */
async function closeMarket(marketId, p1Score = null, p2Score = null) {
  if (p1Score != null && p2Score != null) {
    // Update scores on both open→closed transitions AND re-polls of already-closed markets.
    // COALESCE preserves the original closed_at timestamp on subsequent polls.
    await db.runAsync(
      `UPDATE set_markets
       SET state='closed', closed_at=COALESCE(closed_at, datetime('now')), p1_score=?, p2_score=?
       WHERE id=? AND state IN ('open','closed')`,
      [p1Score, p2Score, marketId]
    );
  } else {
    await db.runAsync(
      `UPDATE set_markets SET state='closed', closed_at=COALESCE(closed_at, datetime('now'))
       WHERE id=? AND state='open'`,
      [marketId]
    );
  }
}

/**
 * Settle a completed set. Idempotent: a market already settled is skipped.
 *
 * Payouts are parimutuel and priced by sideRates(): the winning side is paid
 * from the final pool at the same (scaled-subsidy, bankroll-capped) line the
 * page was showing. By construction a winner is never paid less than a pure pool
 * split, and the house never pays out subsidy it hasn't already earned in rake —
 * so the platform stays net-positive at all times. Losers forfeit their
 * (already-debited) stake; a bet's `locked_odds` is kept only as the price at
 * placement.
 */
async function settleMarket(marketId, winnerId, p1Score = null, p2Score = null) {
  // One transaction for the whole settlement: every payout + state change either
  // all commits or all rolls back, and it can't interleave with live bets landing
  // on the same market (the global write mutex serializes it against placeBet).
  // Bundling N per-winner credits into a single commit is also the batched-
  // settlement win — one durable write instead of one fsync per winner.
  return withWriteTx(async () => {
    const market = await db.getAsync('SELECT * FROM set_markets WHERE id = ?', [marketId]);
    if (!market || market.state === 'settled' || market.state === 'void') return;

    // Bankroll excludes this market's own bets (still 'placed') — a market can't
    // fund its own subsidy.
    const bankroll = await houseBankrollCents();
    const rates = sideRates(market, bankroll);
    const winnerRate = winnerId === market.player1_id ? rates.p1
      : winnerId === market.player2_id ? rates.p2 : null;

    const bets = await db.allAsync(`SELECT * FROM set_bets WHERE market_id = ? AND state = 'placed'`, [marketId]);
    for (const bet of bets) {
      if (winnerRate != null && bet.picked_player_id === winnerId) {
        const payout = Math.round(bet.amount_cents * winnerRate);
        await db.runAsync(`UPDATE set_bets SET state='won', payout_cents=? WHERE id=?`, [payout, bet.id]);
        await wallet.applyCredit(bet.user_id, payout, 'bet_payout', { type: 'set_bet', id: bet.id });
      } else {
        await db.runAsync(`UPDATE set_bets SET state='lost', payout_cents=0 WHERE id=?`, [bet.id]);
      }
    }
    await db.runAsync(
      `UPDATE set_markets
       SET state='settled', winner_id=?, p1_score=COALESCE(?, p1_score), p2_score=COALESCE(?, p2_score),
           settled_at=datetime('now')
       WHERE id=?`,
      [winnerId, p1Score, p2Score, marketId]
    );
    invalidateBankrollCache(); // won/lost set changed
    return { settled: bets.length };
  });
}

/** Cancel a market and refund every placed stake. One atomic transaction. */
async function voidMarket(marketId) {
  return withWriteTx(async () => {
    const market = await db.getAsync('SELECT * FROM set_markets WHERE id = ?', [marketId]);
    if (!market || market.state === 'settled' || market.state === 'void') return;
    const bets = await db.allAsync(`SELECT * FROM set_bets WHERE market_id = ? AND state = 'placed'`, [marketId]);
    for (const bet of bets) {
      await wallet.applyCredit(bet.user_id, bet.amount_cents, 'refund', { type: 'set_bet', id: bet.id });
      await db.runAsync(`UPDATE set_bets SET state='refunded', payout_cents=? WHERE id=?`, [bet.amount_cents, bet.id]);
    }
    await db.runAsync(`UPDATE set_markets SET state='void', settled_at=datetime('now') WHERE id=?`, [marketId]);
    invalidateBankrollCache(); // defensive: bet states changed
  });
}

// ---- Bet placement ----

function sideOdds(market, playerId) {
  if (playerId === market.player1_id) return market.p1_live_odds;
  if (playerId === market.player2_id) return market.p2_live_odds;
  return null;
}

async function recomputeOdds(market) {
  // The displayed line is the same cap-aware price the bettor would be paid if
  // the set settled right now, so what they see is what they'd get (modulo
  // further pool movement). seed_k_cents is persisted purely for transparency.
  const bankroll = await houseBankrollCents();
  const { p1, p2, kEff } = sideRates(market, bankroll);
  await db.runAsync('UPDATE set_markets SET p1_live_odds=?, p2_live_odds=?, seed_k_cents=? WHERE id=?', [p1, p2, kEff, market.id]);
  return { p1Odds: p1, p2Odds: p2 };
}

/**
 * Place a live bet. Locks the odds currently shown for the chosen side, debits
 * the stake, records the bet, grows that side's pool, and re-prices the market.
 */
async function placeBet({ userId, marketId, playerId, amountCents }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    const e = new Error('amountCents must be a positive integer'); e.code = 'BAD_AMOUNT'; throw e;
  }
  // The whole placement is one atomic transaction: read the market, record the
  // bet, debit the stake, grow the pool, reprice. It can't interleave with a
  // settlement of the same market (the mutex serializes them), so a bet can no
  // longer land in the gap between "read placed bets" and "flip to settled" and
  // be silently debited-but-never-paid. Any error (insufficient funds, closed
  // market) rolls the whole thing back — including the bet row.
  return withWriteTx(async () => {
    const market = await db.getAsync('SELECT * FROM set_markets WHERE id = ?', [marketId]);
    if (!market) { const e = new Error('Market not found'); e.code = 'NOT_FOUND'; throw e; }
    if (market.state !== 'open') { const e = new Error('Market is not open for betting'); e.code = 'MARKET_CLOSED'; throw e; }

    const lockedOdds = sideOdds(market, playerId);
    if (lockedOdds == null) { const e = new Error('Player is not in this market'); e.code = 'BAD_PLAYER'; throw e; }

    // Enforce the Fight Money bet sizing rules (min bet + % cap) against the
    // current balance, so the starting grant buys real runway and a single bet
    // can't bust the user.
    const balanceBefore = await wallet.getBalance(userId);
    economy.assertBetWithinLimits(amountCents, balanceBefore);

    const ins = await db.runAsync(
      `INSERT INTO set_bets (user_id, market_id, picked_player_id, amount_cents, locked_odds, state)
       VALUES (?, ?, ?, ?, ?, 'placed')`,
      [userId, marketId, playerId, amountCents, lockedOdds]
    );
    const betId = ins.lastID;

    // Debit within the same transaction. INSUFFICIENT_FUNDS throws, rolling back
    // the bet row too — no compensating delete needed.
    await wallet.applyDebit(userId, amountCents, 'bet_stake', { type: 'set_bet', id: betId });

    const poolCol = playerId === market.player1_id ? 'p1_pool_cents' : 'p2_pool_cents';
    await db.runAsync(`UPDATE set_markets SET ${poolCol} = ${poolCol} + ? WHERE id = ?`, [amountCents, marketId]);

    const updated = await db.getAsync('SELECT * FROM set_markets WHERE id = ?', [marketId]);
    const odds = await recomputeOdds(updated);
    const balanceCents = await wallet.getBalance(userId);
    return { betId, lockedOdds, odds, balanceCents };
  });
}

// ---- Queries (for the API/frontend) ----

/**
 * Markets to show on the live page: open/closed markets plus recently settled
 * ones, joined with player names. Restricted to live tournaments unless
 * includeAll is set.
 */
async function getMarkets({ includeAll = false, pastOnly = false } = {}) {
  const where = includeAll
    ? `1=1`
    : pastOnly
    ? `t.is_live = 0 AND date(t.date) < date('now') AND strftime('%Y', t.date) = '2026' AND m.state = 'settled'`
    : `(t.is_live = 1 OR date(t.date) BETWEEN date('now','-1 day') AND date('now','+2 day'))`;
  // LEFT JOIN the player tables so half-filled (pending) nodes — where one slot
  // is still TBD (player id 0) — are still returned.
  return db.allAsync(
    `SELECT m.*, t.name AS tournament_name, t.logo_url AS tournament_logo_url,
            t.date AS tournament_date, t.city AS tournament_city, t.country AS tournament_country,
            g.name AS game_name,
            p1.name AS player1_name, p2.name AS player2_name
     FROM set_markets m
     JOIN tournaments t ON t.id = m.tournament_id
     JOIN games g ON g.id = m.game_id
     LEFT JOIN players p1 ON p1.id = m.player1_id
     LEFT JOIN players p2 ON p2.id = m.player2_id
     WHERE ${where} AND m.state != 'void'
     ORDER BY (m.state='open') DESC, (m.state='closed') DESC, m.id DESC`
  );
}

async function getUserBets(userId) {
  return db.allAsync(
    `SELECT b.*, m.round_text, m.state AS market_state, m.winner_id,
            t.name AS tournament_name, g.name AS game_name,
            pp.name AS picked_name, p1.name AS player1_name, p2.name AS player2_name
     FROM set_bets b
     JOIN set_markets m ON m.id = b.market_id
     JOIN tournaments t ON t.id = m.tournament_id
     JOIN games g ON g.id = m.game_id
     JOIN players pp ON pp.id = b.picked_player_id
     JOIN players p1 ON p1.id = m.player1_id
     JOIN players p2 ON p2.id = m.player2_id
     WHERE b.user_id = ?
     ORDER BY b.id DESC`,
    [userId]
  );
}

/**
 * Dev convenience: create a few open markets from real players so the live page
 * can be exercised without a tournament actually being in progress. Picks the
 * first game that has >= 2 entrants, flags its tournament live, and pairs the
 * entrants into Top 8 rounds. Idempotent by synthetic set id.
 */
async function seedDemoMarkets() {
  const row = await db.getAsync(
    `SELECT tournament_id, game_id FROM players_games_tournaments
     GROUP BY tournament_id, game_id HAVING COUNT(*) >= 2 LIMIT 1`
  );
  if (!row) throw new Error('No tournament/game with 2+ entrants to seed');
  const T = row.tournament_id, G = row.game_id;
  await db.runAsync('UPDATE tournaments SET is_live = 1 WHERE id = ?', [T]);

  const prows = await db.allAsync('SELECT id FROM players ORDER BY id LIMIT 8');
  if (prows.length < 8) throw new Error('Need at least 8 players to seed a Top 8 bracket');
  const P = prows.map((r) => r.id);
  const pg = `demo-pg-${T}-${G}`;

  const mk = (sid, roundText, roundInt, a, b, seedA, seedB) =>
    ensureOpenMarket({
      tournamentId: T, gameId: G, startggSetId: `demo-${T}-${G}-${sid}`, roundText,
      player1Id: a, player2Id: b, seed1: seedA, seed2: seedB,
      p1WinnersSide: roundText.toLowerCase().includes('grand'),
      roundInt, phaseGroupId: pg,
    });

  // Winners: 2 semis (settled) -> final (open). round_int > 0.
  const wsf1 = await mk('wsf1', 'Winners Semi-Final', 1, P[0], P[1], 1, 4);
  const wsf2 = await mk('wsf2', 'Winners Semi-Final', 1, P[2], P[3], 2, 3);
  await mk('wf', 'Winners Final', 2, P[0], P[2], 1, 2);
  // Losers round 1 (settled) -> round 2 (open). round_int < 0, smaller |round| earlier.
  const lr1a = await mk('lr1a', 'Losers Round 1', -1, P[4], P[5], 5, 8);
  const lr1b = await mk('lr1b', 'Losers Round 1', -1, P[6], P[7], 6, 7);
  await mk('lr2a', 'Losers Quarter-Final', -2, P[1], P[6], 4, 6);
  await mk('lr2b', 'Losers Quarter-Final', -2, P[3], P[4], 3, 5);
  // Losers Semi/Final and Grand Final left as TBD (no market yet).

  // Settle round 1 to show winners + scores.
  await settleMarket(wsf1, P[0], 2, 1);
  await settleMarket(wsf2, P[2], 2, 0);
  await settleMarket(lr1a, P[4], 2, 1);
  await settleMarket(lr1b, P[6], 2, 0);

  return { tournamentId: T, gameId: G, created: 7 };
}

/**
 * Demo only: propagate winners through the seeded Top 8 tree. Production
 * advancement comes from Start.gg via the poller; here we synthesize the next
 * round's markets once both feeders have settled (so no half-filled markets).
 * Call after each demo settle.
 */
async function advanceDemoBracket(tournamentId, gameId) {
  const T = tournamentId, G = gameId;
  const pg = `demo-pg-${T}-${G}`;
  const sid = (s) => `demo-${T}-${G}-${s}`;
  const get = (s) => db.getAsync('SELECT * FROM set_markets WHERE startgg_set_id = ?', [sid(s)]);
  const winner = (m) => (m && m.state === 'settled' ? m.winner_id : null);
  const loser = (m) => (m && m.state === 'settled' ? (m.winner_id === m.player1_id ? m.player2_id : m.player1_id) : null);
  const fill = (s, roundText, roundInt, slot, playerId, seed) =>
    fillBracketSlot({ tournamentId: T, gameId: G, startggSetId: sid(s), roundText, roundInt, slot, playerId, seed, phaseGroupId: pg });

  // Each settled feeder pushes its winner/loser into a specific slot of the next
  // node immediately — the node opens for betting only once both slots are real.
  const wf = await get('wf'), lr2a = await get('lr2a'), lr2b = await get('lr2b');
  if (winner(wf)) await fill('gf', 'Grand Final', 7, 1, winner(wf), 1);   // winners finalist -> GF slot 1
  if (loser(wf)) await fill('lf', 'Losers Final', -4, 1, loser(wf), 2);          // WF loser drops to LF slot 1
  if (winner(lr2a)) await fill('lsf', 'Losers Semi-Final', -3, 1, winner(lr2a), 3);
  if (winner(lr2b)) await fill('lsf', 'Losers Semi-Final', -3, 2, winner(lr2b), 4);
  const lsf = await get('lsf');
  if (winner(lsf)) await fill('lf', 'Losers Final', -4, 2, winner(lsf), 3);
  const lf = await get('lf');
  if (winner(lf)) await fill('gf', 'Grand Final', 7, 2, winner(lf), 2);
}

/**
 * Demo only: wipe all demo markets + their bets so the page can be re-seeded
 * from scratch. Reverses the net wallet impact of those bets (per user) via a
 * single 'demo_reset' ledger entry, so balances return to pre-demo and the
 * ledger still sums correctly.
 */
async function clearDemoMarkets() {
  // One atomic transaction: the reconciliation read, the per-user reversals, and
  // the row deletes must all commit together. Otherwise a throw partway (e.g. a
  // user spent their demo winnings, so the reversing debit fails) would leave
  // some balances reversed and the bets still present — and a re-run would then
  // double-reverse. Uses raw apply* primitives since we already hold the tx.
  return withWriteTx(async () => {
    const bets = await db.allAsync(
      `SELECT b.id, b.user_id FROM set_bets b
       JOIN set_markets m ON m.id = b.market_id
       WHERE m.startgg_set_id LIKE 'demo-%'`
    );
    const perUser = {};
    for (const bet of bets) {
      const row = await db.getAsync(
        `SELECT COALESCE(SUM(amount_cents), 0) AS net FROM wallet_transactions WHERE ref_type = 'set_bet' AND ref_id = ?`,
        [bet.id]
      );
      perUser[bet.user_id] = (perUser[bet.user_id] || 0) + row.net;
    }
    for (const [userId, net] of Object.entries(perUser)) {
      if (net < 0) await wallet.applyCredit(Number(userId), -net, 'demo_reset');
      else if (net > 0) await wallet.applyDebit(Number(userId), net, 'demo_reset');
    }

    await db.runAsync(
      `DELETE FROM set_bets WHERE market_id IN (SELECT id FROM set_markets WHERE startgg_set_id LIKE 'demo-%')`
    );
    await db.runAsync(`DELETE FROM set_markets WHERE startgg_set_id LIKE 'demo-%'`);
    invalidateBankrollCache(); // deleted won/lost bets change the bankroll sum
    return { cleared: bets.length };
  });
}

// Read-only: all upcoming tracked tournaments that have seeded players, each
// with their games list. Powers the Live page's pre-Top-8 "waiting room".
// Returns an array (empty when nothing is scheduled).
async function getUpcoming() {
  const tournaments = await db.allAsync(
    `SELECT id, name, date, city, country, logo_url AS logoUrl, is_live AS isLive FROM tournaments t
     WHERE startgg_id IS NOT NULL
       AND (is_live = 1 OR date(date) >= date('now','-1 day'))
     ORDER BY is_live DESC, date(date) ASC`
  );
  return Promise.all(tournaments.map(async (tournament) => {
    const games = await db.allAsync(
      `SELECT DISTINCT g.id, g.name
       FROM players_games_tournaments pgt
       JOIN games g ON g.id = pgt.game_id
       WHERE pgt.tournament_id = ?
       ORDER BY g.name`,
      [tournament.id]
    );
    return { tournament, games };
  }));
}

module.exports = {
  ensureOpenMarket, fillBracketSlot, closeMarket, settleMarket, voidMarket,
  placeBet, recomputeOdds, getMarkets, getUserBets, houseBankrollCents, sideRates,
  seedDemoMarkets, advanceDemoBracket, clearDemoMarkets, getUpcoming,
  invalidateBankrollCache,
};
