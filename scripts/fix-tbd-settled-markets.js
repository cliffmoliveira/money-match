/**
 * One-shot repair for a bug fixed in liveMarkets.js's settleMarket(): a
 * market could get force-settled with one slot still the TBD sentinel (id
 * 0) when fillBracketSlot's stillActive guard returned early for the other
 * player (they already had an active match elsewhere - e.g. a stale row
 * left behind by a start.gg set-id reassignment), leaving the market
 * "settled" with a real winner/score on one side and TBD on the other.
 * Confirmed live: EWC 2026 FATAL FURY LCQ's Losers Semis showed
 * "Pida 0 - TBD 3".
 *
 * A market only opens for betting once both slots are real (see
 * fillBracketSlot), so a market still holding the TBD sentinel at settle
 * time never passed through 'open' - it should have zero real bets. This
 * script defensively refunds any 'placed' bet found anyway (belt-and-
 * suspenders, matching refundOrphanedVoidBets' pattern) before resetting
 * the market to 'pending' so the live poller naturally re-fills and
 * correctly re-settles it once the real opponent's slot is known.
 *
 * Usage:
 *   node scripts/fix-tbd-settled-markets.js --dry-run   # report only, no writes
 *   node scripts/fix-tbd-settled-markets.js             # repair
 */
require('dotenv').config();
const db = require('../db/db');
const wallet = require('../wallet');

const DRY = process.argv.includes('--dry-run');

async function main() {
  const broken = await db.allAsync(
    `SELECT sm.*, t.name AS tournament_name
     FROM set_markets sm
     JOIN tournaments t ON t.id = sm.tournament_id
     WHERE sm.state = 'settled' AND (sm.player1_id = 0 OR sm.player2_id = 0 OR sm.player1_id IS NULL OR sm.player2_id IS NULL)`
  );

  console.log(`${DRY ? '[DRY-RUN] ' : ''}Found ${broken.length} settled market(s) with an unfilled (TBD) slot.`);

  for (const m of broken) {
    console.log(`  - market ${m.id}: ${m.tournament_name} / ${m.round_text || '(no round)'} — player1_id=${m.player1_id} player2_id=${m.player2_id} winner_id=${m.winner_id} score=${m.p1_score}-${m.p2_score}`);

    const stray = await db.allAsync(`SELECT * FROM set_bets WHERE market_id = ? AND state = 'placed'`, [m.id]);
    if (stray.length > 0) {
      console.log(`    ! ${stray.length} bet(s) unexpectedly still 'placed' on this market`);
    }

    if (DRY) continue;

    for (const bet of stray) {
      await wallet.applyCredit(bet.user_id, bet.amount_cents, 'refund', { type: 'set_bet', id: bet.id });
      await db.runAsync(`UPDATE set_bets SET state='refunded', payout_cents=? WHERE id=?`, [bet.amount_cents, bet.id]);
    }

    await db.runAsync(
      `UPDATE set_markets
       SET state='pending', winner_id=NULL, p1_score=NULL, p2_score=NULL, settled_at=NULL
       WHERE id=?`,
      [m.id]
    );
    console.log(`    ✓ reset to pending`);
  }

  console.log(`\nDone. ${DRY ? 'Would repair' : 'Repaired'} ${broken.length} market(s).`);
  process.exit(0);
}

main();
