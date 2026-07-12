// One-time migration: NULL every players.startgg_id value.
//
// Why: before scripts/lib/players.js existed, every ingestion script wrote
// Start.gg's per-tournament Entrant.id into players.startgg_id — NOT a
// stable identifier (it changes every time the same real person enters a
// new event; only Participant.player.id is stable). So as of this
// migration, 100% of existing startgg_id values are semantically wrong for
// their new purpose (matching a player across tournaments) and could, in
// principle, coincidentally collide with a real future player.id and merge
// two unrelated people's data. Nulling them removes that (low-probability
// but nonzero) risk and lets every player self-heal to their correct,
// stable id: findOrCreatePlayerId falls back to an exact name match when
// startgg_id doesn't hit, and now unconditionally overwrites startgg_id
// (rather than the old COALESCE-locks-the-first-value behavior) — so each
// player self-heals to their correct player.id the next time any sync
// script touches them.
//
// Does NOT touch anything else: no rows are deleted or merged (that's
// scripts/merge-duplicate-player.js, a separate, per-pair-reviewed step for
// the ~45 known legacy/modern duplicate pairs — this migration doesn't
// affect that list either way).
//
// Usage:
//   node scripts/reset-player-startgg-ids.js --dry-run
//   node scripts/reset-player-startgg-ids.js

const db = require('../db/db');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { c: count } = await db.getAsync('SELECT COUNT(*) AS c FROM players WHERE startgg_id IS NOT NULL');
  console.log(`${count} player row(s) currently have a non-null startgg_id (all entrant-id-based; will self-heal to real player.id on next sync touch).`);
  if (dryRun) {
    console.log('--dry-run: no writes performed.');
    await db.closeAsync();
    return;
  }
  const { changes } = await db.runAsync('UPDATE players SET startgg_id = NULL WHERE startgg_id IS NOT NULL');
  console.log(`Done. Cleared startgg_id on ${changes} player row(s).`);
  await db.closeAsync();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
