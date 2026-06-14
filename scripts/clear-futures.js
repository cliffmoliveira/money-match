// One-off cleanup: clear all futures data (entrants + their bets) so the gated
// sync repopulates only genuinely-seeded events. The existing rows came from
// far-future tournaments whose Start.gg seeding isn't real yet (provisional seed
// values, wrong players), so they should not be shown.
//
// This touches ONLY the futures tables:
//   - players_games_tournaments  (futures entrants)
//   - bets                       (futures bets)
// Live per-set betting (set_markets, set_bets) and the wallet are untouched.
// Tournaments themselves are kept, so they still list with countdown timers.
//
// Usage:  node scripts/clear-futures.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../db/db');

(async () => {
  const b = await db.runAsync('DELETE FROM bets');
  const p = await db.runAsync('DELETE FROM players_games_tournaments');
  const t = await db.allAsync('SELECT COUNT(*) AS c FROM tournaments WHERE date >= date(\'now\')');
  console.log(`Cleared ${b.changes} futures bet(s) and ${p.changes} futures entrant(s).`);
  console.log(`${t[0].c} upcoming tournament(s) remain and will show countdown timers.`);
  process.exit(0);
})().catch((e) => { console.error('Cleanup failed:', e.message); process.exit(1); });
