// Merge two player rows that BOTH already carry a real, distinct start.gg
// identity — i.e. exactly the case scripts/merge-duplicate-player.js
// refuses to touch.
//
// Why this exists: scripts/lib/players.js keys players.startgg_id on
// participants[].player.id, which is stable across sponsor-tag changes for
// one start.gg ACCOUNT. It can't help when the same real person competes
// under two separate start.gg accounts (different player.id each), which is
// exactly what happened to xiaohai: "FALCONS | xiaohai" (startgg_id
// 4004146, Evo/Combo Breaker) and "Falcons丨Xiaohai" (startgg_id 5479000, a
// FightClub Championship Asia entrant using a CJK fullwidth "丨" separator)
// are the same real player, confirmed by tag/sponsor/timeline, but start.gg
// itself has no shared id linking them — so this can't be automated and
// needs a human to confirm the two rows really are the same person before
// merging, hence --confirm-same-person is mandatory rather than inferred.
//
// This does NOT prevent recurrence: a future sync for either startgg_id
// will recreate a fresh duplicate row, since the surviving row keeps only
// one startgg_id/name. Re-run this script if that happens again.
//
// Usage:
//   node scripts/merge-same-person-player.js <fromId> <intoId> --confirm-same-person [--dry-run]

const db = require('../db/db');

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const confirmed = args.includes('--confirm-same-person');
  const [fromIdStr, intoIdStr] = args.filter((a) => !a.startsWith('--'));
  const fromId = Number(fromIdStr);
  const intoId = Number(intoIdStr);
  if (!Number.isInteger(fromId) || !Number.isInteger(intoId) || fromId === intoId) {
    fail('usage: node scripts/merge-same-person-player.js <fromId> <intoId> --confirm-same-person [--dry-run]');
  }
  if (!confirmed) {
    fail('refusing to merge two players without --confirm-same-person — verify externally (tag, sponsor, timeline, or start.gg profile) that these are the same real person first');
  }

  const from = await db.getAsync('SELECT id, name, startgg_id FROM players WHERE id = ?', [fromId]);
  const into = await db.getAsync('SELECT id, name, startgg_id FROM players WHERE id = ?', [intoId]);
  if (!from) fail(`player id ${fromId} not found`);
  if (!into) fail(`player id ${intoId} not found`);

  // Same FK table list as merge-duplicate-player.js.
  const simpleFkTables = [
    { table: 'matches', cols: ['player1_id', 'player2_id', 'winner_id', 'loser_id'] },
    { table: 'tournaments', cols: ['winner_id'] },
    { table: 'players_games_tournaments', cols: ['player_id'] },
    { table: 'bets', cols: ['player_id'] },
    { table: 'set_markets', cols: ['player1_id', 'player2_id', 'winner_id'] },
    { table: 'set_bets', cols: ['picked_player_id'] },
    { table: 'pickem_picks', cols: ['picked_player_id'] },
    { table: 'parlay_legs', cols: ['player_id'] },
    { table: 'bracket_history', cols: ['player1_id', 'player2_id', 'winner_id'] },
  ];

  console.log(`Merging player ${fromId} ("${from.name}", startgg_id=${from.startgg_id}) -> player ${intoId} ("${into.name}", startgg_id=${into.startgg_id})`);

  const counts = {};
  for (const { table, cols } of simpleFkTables) {
    for (const col of cols) {
      const { c } = await db.getAsync(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`, [fromId]);
      if (c > 0) counts[`${table}.${col}`] = c;
    }
  }
  const followRows = await db.allAsync('SELECT user_id FROM follows WHERE player_id = ?', [fromId]);
  if (followRows.length) counts['follows.player_id'] = followRows.length;

  if (Object.keys(counts).length === 0) {
    console.log('Nothing references the source player — nothing to repoint. Will still delete the empty row.');
  } else {
    console.log('Rows to repoint:', JSON.stringify(counts));
  }

  if (dryRun) {
    console.log('--dry-run: no writes performed.');
    await db.closeAsync();
    return;
  }

  await db.runAsync('BEGIN');
  try {
    for (const { table, cols } of simpleFkTables) {
      for (const col of cols) {
        await db.runAsync(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [intoId, fromId]);
      }
    }
    for (const { user_id } of followRows) {
      await db.runAsync('INSERT OR IGNORE INTO follows (user_id, player_id) VALUES (?, ?)', [user_id, intoId]);
    }
    await db.runAsync('DELETE FROM follows WHERE player_id = ?', [fromId]);

    await db.runAsync('DELETE FROM players WHERE id = ?', [fromId]);
    await db.runAsync('COMMIT');
    console.log(`Done. Player ${fromId} merged into ${intoId} and removed.`);
    console.log(`Note: player ${intoId} still only has startgg_id=${into.startgg_id} on file — a future sync under startgg_id=${from.startgg_id} or the exact name "${from.name}" will recreate a fresh duplicate, not self-heal into this row.`);
  } catch (err) {
    await db.runAsync('ROLLBACK');
    throw err;
  }
  await db.closeAsync();
}

main().catch((err) => {
  console.error('Merge failed:', err);
  process.exit(1);
});
