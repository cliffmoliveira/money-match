/**
 * READ-ONLY diagnostic: find set_bets whose market_id points at a voided
 * market, and check whether a *different* (non-void) market exists for the
 * same real matchup (same tournament/game/round/players) — evidence that
 * the bracket got a duplicate/replacement market row for that slot, leaving
 * the user's bet permanently orphaned from what the bracket UI now shows.
 *
 * Makes no writes. Safe to run anytime, including against production.
 *
 * Usage:
 *   node scripts/diagnose-orphaned-bets.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../db/db');

async function main() {
  const orphaned = await db.allAsync(`
    SELECT sb.id AS bet_id, sb.user_id, sb.market_id, sb.state AS bet_state,
           sb.amount_cents, sb.locked_odds,
           sm.tournament_id, sm.game_id, sm.round_text, sm.player1_id, sm.player2_id,
           t.name AS tournament_name,
           p1.name AS p1_name, p2.name AS p2_name
    FROM set_bets sb
    JOIN set_markets sm ON sm.id = sb.market_id
    JOIN tournaments t ON t.id = sm.tournament_id
    LEFT JOIN players p1 ON p1.id = sm.player1_id
    LEFT JOIN players p2 ON p2.id = sm.player2_id
    WHERE sm.state = 'void'
    ORDER BY t.name, sm.round_text
  `);

  if (orphaned.length === 0) {
    console.log('No set_bets found on voided markets. Nothing orphaned right now.');
    process.exit(0);
  }

  console.log(`Found ${orphaned.length} bet(s) sitting on a voided market:\n`);

  for (const bet of orphaned) {
    // Same real matchup: same tournament/game/round, same two players in
    // either order, but a different (non-void) market id.
    const replacement = await db.getAsync(
      `SELECT id, state, p1_score, p2_score, winner_id
       FROM set_markets
       WHERE tournament_id = ? AND game_id = ? AND round_text = ?
         AND id != ?
         AND ((player1_id = ? AND player2_id = ?) OR (player1_id = ? AND player2_id = ?))
         AND state != 'void'`,
      [bet.tournament_id, bet.game_id, bet.round_text, bet.market_id,
       bet.player1_id, bet.player2_id, bet.player2_id, bet.player1_id]
    );

    console.log(`Bet ${bet.bet_id} (user ${bet.user_id}, ${(bet.amount_cents / 100).toFixed(2)} FM @ ${bet.locked_odds}x, state=${bet.bet_state})`);
    console.log(`  "${bet.tournament_name}" — ${bet.round_text}: ${bet.p1_name || '?'} vs ${bet.p2_name || '?'}`);
    console.log(`  orphaned market_id=${bet.market_id} (void)`);
    if (replacement) {
      console.log(`  -> REPLACEMENT FOUND: market_id=${replacement.id} state=${replacement.state} score=${replacement.p1_score}-${replacement.p2_score} winner_id=${replacement.winner_id}`);
    } else {
      console.log('  -> no replacement market found for this matchup');
    }
    console.log('');
  }

  const withReplacement = await Promise.all(orphaned.map(async (bet) => {
    const r = await db.getAsync(
      `SELECT id FROM set_markets
       WHERE tournament_id = ? AND game_id = ? AND round_text = ?
         AND id != ?
         AND ((player1_id = ? AND player2_id = ?) OR (player1_id = ? AND player2_id = ?))
         AND state != 'void'`,
      [bet.tournament_id, bet.game_id, bet.round_text, bet.market_id,
       bet.player1_id, bet.player2_id, bet.player2_id, bet.player1_id]
    );
    return !!r;
  }));
  const confirmedCount = withReplacement.filter(Boolean).length;
  console.log(`Summary: ${orphaned.length} orphaned bet(s), ${confirmedCount} with a confirmed replacement market (duplicate-market theory), ${orphaned.length - confirmedCount} unexplained.`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
