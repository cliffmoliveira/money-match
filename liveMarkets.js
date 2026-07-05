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
  // Everything below reads and writes set_markets/set_bets across several
  // statements (void a preview, maybe reopen a void market, fill a slot, maybe
  // open it) — running it as one withWriteTx transaction serializes it against
  // placeBet/settleMarket/voidMarket on the same global mutex, so a bet can
  // never land in the gap between two of these steps (the gap that let a stray
  // 'placed' bet survive a market being reused — see refundOrphanedVoidBets).
  return withWriteTx(async () => {

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
    // entered late. Refund any bet still 'placed' from the market's PRIOR
    // occupancy first — reusing the row must never carry a stray bet into the
    // new matchup, where it would be graded against an unrelated winner.
    const stray = await db.allAsync(`SELECT * FROM set_bets WHERE market_id = ? AND state = 'placed'`, [existing.id]);
    for (const bet of stray) {
      await wallet.applyCredit(bet.user_id, bet.amount_cents, 'refund', { type: 'set_bet', id: bet.id });
      await db.runAsync(`UPDATE set_bets SET state='refunded', payout_cents=? WHERE id=?`, [bet.amount_cents, bet.id]);
    }
    if (stray.length) invalidateBankrollCache();
    // Reset to blank-pending so the slot updates below re-fill it and the
    // market opens normally once both players are known.
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
  });
}

/** Set in progress -> stop taking bets. Optionally write mid-match scores (updates on every poll). */
async function closeMarket(marketId, p1Score = null, p2Score = null) {
  return withWriteTx(async () => {
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
  });
}

/**
 * Settle a completed set. Idempotent AND self-healing: a market already
 * settled skips re-writing its own state (winner/scores/settled_at stay as
 * first recorded), but still sweeps and grades any bet somehow still
 * 'placed' on it, using the market's own persisted winner_id rather than the
 * caller's argument — so a stray re-call can never re-grade with a different
 * winner. In the common case (nothing stray) this sweep finds zero rows and
 * is a cheap no-op, same as before.
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
    if (!market || market.state === 'void') return; // a void market has no winner; never settle it after the fact
    const alreadySettled = market.state === 'settled';
    // Guard against settling a slot that was never actually filled. Can happen
    // when fillBracketSlot's stillActive guard returns early for one player
    // (they already have an active match elsewhere) while start.gg still
    // reports the set as complete - without this check the market gets
    // force-settled with one side still the TBD sentinel (id 0), showing as
    // "TBD" winning a real score in the bracket. Safe to skip: the caller
    // (scripts/sync-live.js) re-polls and retries settlement once the slot
    // genuinely fills in.
    if (!alreadySettled && (!market.player1_id || !market.player2_id)) return;
    // Authoritative once settled: ignore the caller's argument so a stray
    // re-call can't re-grade the market against a different winner.
    const effectiveWinnerId = alreadySettled ? market.winner_id : winnerId;

    // Bankroll excludes this market's own bets (still 'placed') — a market can't
    // fund its own subsidy.
    const bankroll = await houseBankrollCents();
    const rates = sideRates(market, bankroll);
    const winnerRate = effectiveWinnerId === market.player1_id ? rates.p1
      : effectiveWinnerId === market.player2_id ? rates.p2 : null;

    const bets = await db.allAsync(`SELECT * FROM set_bets WHERE market_id = ? AND state = 'placed'`, [marketId]);
    for (const bet of bets) {
      if (winnerRate != null && bet.picked_player_id === effectiveWinnerId) {
        const payout = Math.round(bet.amount_cents * winnerRate);
        await db.runAsync(`UPDATE set_bets SET state='won', payout_cents=? WHERE id=?`, [payout, bet.id]);
        await wallet.applyCredit(bet.user_id, payout, 'bet_payout', { type: 'set_bet', id: bet.id });
      } else {
        await db.runAsync(`UPDATE set_bets SET state='lost', payout_cents=0 WHERE id=?`, [bet.id]);
      }
    }
    if (!alreadySettled) {
      await db.runAsync(
        `UPDATE set_markets
         SET state='settled', winner_id=?, p1_score=COALESCE(?, p1_score), p2_score=COALESCE(?, p2_score),
             settled_at=datetime('now')
         WHERE id=?`,
        [winnerId, p1Score, p2Score, marketId]
      );
    }
    if (bets.length) invalidateBankrollCache(); // won/lost set changed
    return { settled: bets.length };
  });
}

/**
 * Cancel a market and refund every placed stake. Idempotent AND self-healing:
 * a market already void skips re-writing its own state, but still sweeps and
 * refunds any bet somehow still 'placed' on it (see fillBracketSlot's void-
 * reuse path and refundOrphanedVoidBets for how that can happen). In the
 * common case this sweep finds zero rows and is a cheap no-op, same as before.
 */
async function voidMarket(marketId) {
  return withWriteTx(async () => {
    const market = await db.getAsync('SELECT * FROM set_markets WHERE id = ?', [marketId]);
    if (!market || market.state === 'settled') return; // a settled market has a real winner; never void it after the fact
    const bets = await db.allAsync(`SELECT * FROM set_bets WHERE market_id = ? AND state = 'placed'`, [marketId]);
    for (const bet of bets) {
      await wallet.applyCredit(bet.user_id, bet.amount_cents, 'refund', { type: 'set_bet', id: bet.id });
      await db.runAsync(`UPDATE set_bets SET state='refunded', payout_cents=? WHERE id=?`, [bet.amount_cents, bet.id]);
    }
    if (market.state !== 'void') {
      await db.runAsync(`UPDATE set_markets SET state='void', settled_at=datetime('now') WHERE id=?`, [marketId]);
    }
    if (bets.length) invalidateBankrollCache(); // defensive: bet states changed
  });
}

/**
 * Boot-time safety net: refund any set_bets stuck 'placed' on a market
 * that's already 'void', in case one ever slips past voidMarket()'s own
 * self-healing sweep (e.g. a market that's voided once and never touched by
 * voidMarket()/fillBracketSlot() again, so the bet has no future trigger to
 * catch it). Scoped strictly to state='void' markets: a 'settled' market
 * with a real winner needs win/loss grading, not a blanket refund, so this
 * intentionally does not touch that case. Idempotent — finds nothing once
 * the DB is clean, cheap to run on every boot.
 */
async function refundOrphanedVoidBets() {
  return withWriteTx(async () => {
    const orphaned = await db.allAsync(
      `SELECT sb.* FROM set_bets sb
       JOIN set_markets sm ON sm.id = sb.market_id
       WHERE sb.state = 'placed' AND sm.state = 'void'`
    );
    for (const bet of orphaned) {
      await wallet.applyCredit(bet.user_id, bet.amount_cents, 'refund', { type: 'set_bet', id: bet.id });
      await db.runAsync(`UPDATE set_bets SET state='refunded', payout_cents=? WHERE id=?`, [bet.amount_cents, bet.id]);
    }
    if (orphaned.length) invalidateBankrollCache();
    return { refunded: orphaned.length, totalCents: orphaned.reduce((s, b) => s + b.amount_cents, 0) };
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
    // A tournament stays "current" once its date arrives, or while it still has
    // an open/closed market (covers results trickling in past midnight). No blind
    // "-1 day" grace: once fully settled and its date has passed, it belongs only
    // in Past Tournaments, not duplicated here too.
    //
    // Scoped to `tournaments` (a couple hundred rows) rather than an OR/EXISTS
    // directly against `m` — that shape can't use m's tournament_id index, so
    // SQLite full-scans every set_markets row (thousands, growing) to evaluate
    // it. Pre-resolving the qualifying tournament ids here keeps the scan on
    // the small table and lets the outer query stay an indexed lookup.
    : `m.tournament_id IN (
        SELECT id FROM tournaments t2
        WHERE t2.is_live = 1
           OR date(t2.date) BETWEEN date('now') AND date('now','+2 day')
           OR EXISTS (SELECT 1 FROM set_markets sm2 WHERE sm2.tournament_id = t2.id AND sm2.state IN ('open','closed'))
      )`;
  // LEFT JOIN the player tables so half-filled (pending) nodes — where one slot
  // is still TBD (player id 0) — are still returned.
  return db.allAsync(
    `SELECT m.*, t.name AS tournament_name, t.logo_url AS tournament_logo_url,
            t.date AS tournament_date, t.city AS tournament_city, t.country AS tournament_country,
            (SELECT SUM(num_entrants) FROM tournament_games tg WHERE tg.tournament_id = t.id) AS tournament_num_entrants,
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
            pp.name AS picked_name, p1.name AS player1_name, p2.name AS player2_name,
            CASE WHEN b.picked_player_id = m.player1_id THEN p2.name ELSE p1.name END AS opp_name
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

// Read-only: all upcoming tracked tournaments, each with their games list.
// Games come from players_games_tournaments (seeded) OR tournament_games
// (pre-seeding game associations), whichever has data. Powers the Live
// page's "waiting room" pill for future tournaments.
// Returns an array sorted furthest-out first (empty when nothing is scheduled).
async function getUpcoming() {
  const tournaments = await db.allAsync(
    `SELECT id, name, date, city, country, logo_url AS logoUrl, is_live AS isLive,
       (SELECT SUM(num_entrants) FROM tournament_games tg WHERE tg.tournament_id = t.id) AS numEntrants,
       EXISTS (SELECT 1 FROM bracket_history bh WHERE bh.tournament_id = t.id AND bh.state = 'in_progress') AS hasLiveRound
     FROM tournaments t
     WHERE startgg_id IS NOT NULL
       AND (is_live = 1
            OR date(date) >= date('now')
            OR EXISTS (SELECT 1 FROM set_markets sm2 WHERE sm2.tournament_id = t.id AND sm2.state IN ('open','closed')))
     ORDER BY date(date) DESC`
  );
  return Promise.all(tournaments.map(async (tournament) => {
    const games = await db.allAsync(
      `SELECT DISTINCT g.id, g.name
       FROM (
         SELECT game_id FROM players_games_tournaments WHERE tournament_id = ?
         UNION
         SELECT game_id FROM tournament_games WHERE tournament_id = ?
       ) AS src
       JOIN games g ON g.id = src.game_id
       ORDER BY g.name`,
      [tournament.id, tournament.id]
    );
    return { tournament, games };
  }));
}

// Read-only: round-by-round history for a game's pre-Top-8 rounds — powers
// the Bracket Tracker's round pills, results feed, and still-alive list.
// Entirely separate from set_markets: no odds, no stakes, nothing bettable.
// These exact round names also belong to the real Top 8 bracket (mirrors
// scripts/sync-live.js's TOP8_ROUNDS/isTop8Round - duplicated rather than
// imported since sync-live.js already requires this module, and requiring
// it back would be circular). A pre-Top-8 history round stuck with one of
// these names is easy to mistake for the actual Top 8 already underway, so
// getGameTracker() relabels those as "Round of N" instead.
const AMBIGUOUS_ROUND_NAMES = [
  /grand final/,
  /winners final/,
  /winners semi final/,
  /losers final/,
  /losers semi final/,
  /losers quarter final/,
];
function isAmbiguousRoundName(text) {
  const n = (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return AMBIGUOUS_ROUND_NAMES.some((re) => re.test(n));
}

// "[Winners/Losers ]Round of N" - N is this round's own distinct entrant
// count, rounded up to the nearest power of two (byes mean brackets rarely
// land on an exact power of two), so the label reads as "how many were left
// entering this round" rather than a raw, possibly-odd headcount. Prefixed
// with the bracket side (read off the original round_text) when present -
// a Winners-side round and a Losers-side round can easily land on the same
// entrant count (e.g. both "Round of 16"), and without the prefix they'd
// render as two pills with identical text. Returns null when none of this
// round's sets have entrant ids on file (start.gg occasionally omits them
// for older historical sets) - guessing a fixed default here would make
// every such round collide on the identical label instead of just this one.
function roundOfLabel(sets, roundText) {
  const entrants = new Set();
  for (const s of sets) {
    if (s.player1_id) entrants.add(s.player1_id);
    if (s.player2_id) entrants.add(s.player2_id);
  }
  if (entrants.size === 0) return null;
  const n = 2 ** Math.ceil(Math.log2(entrants.size));
  const side = /losers/i.test(roundText || '') ? 'Losers ' : /winners/i.test(roundText || '') ? 'Winners ' : '';
  return `${side}Round of ${n}`;
}

async function getGameTracker(tournamentId, gameId) {
  const rows = await db.allAsync(
    `SELECT round_text, round_int, phase_order, state,
            player1_id, player2_id, winner_id, player1_score, player2_score, updated_at
     FROM bracket_history
     WHERE tournament_id = ? AND game_id = ?
     ORDER BY phase_order ASC, round_int ASC, updated_at DESC`,
    [tournamentId, gameId]
  );

  const byRound = new Map();
  for (const r of rows) {
    const key = r.round_text;
    if (!byRound.has(key)) byRound.set(key, { roundText: r.round_text, roundInt: r.round_int, phaseOrder: r.phase_order, sets: [] });
    byRound.get(key).sets.push(r);
  }
  // Raw round_text (e.g. "Losers Quarter-Final") -> display label. Computed
  // once per group so a round's pill and every one of its results use the
  // identical string - the frontend filters results by exact match against
  // the selected pill's roundText.
  //
  // The Winners/Losers prefix in roundOfLabel() disambiguates most collisions,
  // but not all: two rounds on the SAME side can round up to the same
  // entrant count (e.g. two different Losers rounds both landing on "Losers
  // Round of 8"), and "Grand Final" collides with "Grand Final Reset" (same
  // regex match, both naturally ~2 entrants). usedLabels tracks every label
  // already claimed - whichever round would collide falls back to its real,
  // guaranteed-unique round_text (byRound's own Map key) instead of a
  // duplicate. This is a strict superset of the "no entrant data" fallback
  // below, so it's folded into the same check.
  const displayLabel = new Map();
  const usedLabels = new Set();
  for (const g of byRound.values()) {
    let label = (isAmbiguousRoundName(g.roundText) ? roundOfLabel(g.sets, g.roundText) : null) || g.roundText;
    if (usedLabels.has(label)) label = g.roundText;
    usedLabels.add(label);
    displayLabel.set(g.roundText, label);
  }
  // "done" once every set has a result; "live" once at least one set has
  // started or finished; "next" when every set is still 'pending' - start.gg
  // generates the whole bracket shell (all sets pending) long before a
  // tournament's early rounds start, so without the "next" case every future
  // round would falsely read as "live" from the moment it's first synced.
  const rounds = [...byRound.values()].map((g) => {
    const allDone = g.sets.every((s) => s.state === 'completed');
    const anyStarted = g.sets.some((s) => s.state === 'in_progress' || s.state === 'completed');
    return {
      roundText: displayLabel.get(g.roundText),
      roundInt: g.roundInt,
      status: allDone ? 'done' : anyStarted ? 'live' : 'next',
    };
  });

  const playerIds = [...new Set(rows.flatMap((r) => [r.player1_id, r.player2_id]).filter(Boolean))];
  const players = playerIds.length
    ? await db.allAsync(`SELECT id, name FROM players WHERE id IN (${playerIds.map(() => '?').join(',')})`, playerIds)
    : [];
  const nameOf = (id) => players.find((p) => p.id === id)?.name || null;

  const completed = rows.filter((r) => r.state === 'completed' && r.winner_id != null)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const results = completed.map((r) => {
    const winnerIsP1 = r.winner_id === r.player1_id;
    const loserId = winnerIsP1 ? r.player2_id : r.player1_id;
    const winnerScore = winnerIsP1 ? r.player1_score : r.player2_score;
    const loserScore = winnerIsP1 ? r.player2_score : r.player1_score;
    return {
      winner: nameOf(r.winner_id),
      loser: nameOf(loserId),
      winnerScore: winnerScore ?? 0,
      loserScore: loserScore ?? 0,
      round: displayLabel.get(r.round_text) ?? r.round_text,
    };
  });

  const losers = new Set(completed.map((r) => (r.winner_id === r.player1_id ? r.player2_id : r.player1_id)).filter(Boolean));
  const seeds = await db.allAsync(
    `SELECT pgt.player_id, p.name AS player_name, pgt.seed_num
     FROM players_games_tournaments pgt
     JOIN players p ON p.id = pgt.player_id
     WHERE pgt.tournament_id = ? AND pgt.game_id = ? AND pgt.seed_num IS NOT NULL
     ORDER BY pgt.seed_num`,
    [tournamentId, gameId]
  );
  const stillAlive = seeds
    .filter((s) => !losers.has(s.player_id))
    .map((s) => ({ seed: s.seed_num, name: s.player_name }));

  return { rounds, results, stillAlive };
}

module.exports = {
  ensureOpenMarket, fillBracketSlot, closeMarket, settleMarket, voidMarket,
  refundOrphanedVoidBets,
  placeBet, recomputeOdds, getMarkets, getUserBets, houseBankrollCents, sideRates,
  seedDemoMarkets, advanceDemoBracket, clearDemoMarkets, getUpcoming,
  invalidateBankrollCache, getGameTracker,
};
