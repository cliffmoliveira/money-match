/**
 * Dev-only: seed a settled pick'em demo market so the leaderboard / profile /
 * overlay have data to render. Idempotent on the demo market id.
 *   DATABASE_PATH=./db/database.db node scripts/seed-pickem-demo.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');
const { applyPickemSchema } = require('../pickem/schema');
const engine = require('../pickem/engine');

const M = 900001; // high id; won't collide with poller markets

(async () => {
  await applyPickemSchema(db);
  const p1 = await db.getAsync('SELECT id, name FROM players ORDER BY id LIMIT 1');
  const p2 = await db.getAsync('SELECT id, name FROM players ORDER BY id LIMIT 1 OFFSET 1');
  const t = await db.getAsync('SELECT id FROM tournaments ORDER BY id LIMIT 1');
  const g = await db.getAsync('SELECT id FROM games ORDER BY id LIMIT 1');

  await db.runAsync('DELETE FROM pickem_picks WHERE market_id = ?', [M]);
  await db.runAsync('DELETE FROM set_markets WHERE id = ?', [M]);
  await db.runAsync(
    `INSERT INTO set_markets
      (id, tournament_id, game_id, player1_id, player2_id, state, round, round_text, locks_at,
       p1_prob, p2_prob, seed_k_cents, p1_live_odds, p2_live_odds)
     VALUES (?,?,?,?,?,'open','top8','Top 8','2099-01-01T00:00:00Z',0.5,0.5,20000,1.9,1.9)`,
    [M, t.id, g.id, p1.id, p2.id]
  );

  for (const u of [1, 2, 3, 4]) await engine.placePick({ userId: u, marketId: M, pickedPlayerId: p1.id });
  for (const u of [5, 6]) await engine.placePick({ userId: u, marketId: M, pickedPlayerId: p2.id });

  await engine.lockMarket(M);
  await engine.settleMarket(M, p1.id, new Date().toISOString());
  console.log(`Seeded pick'em demo market ${M}: ${p1.name} vs ${p2.name}, winner ${p1.name}.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
