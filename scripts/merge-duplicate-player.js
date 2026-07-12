// Merge a legacy player row (usually a bare-name row from the original
// Grand-Finals-only `matches` backfill, startgg_id NULL) into the modern,
// actively-synced row for the same real person (sponsor-tagged name, real
// startgg_id, players_games_tournaments/set_markets data attached).
//
// Why this exists: the old backfill created players by bare gamertag before
// the live start.gg entrant sync (which uses "SPONSOR | tag" names) existed.
// For any player who competed again after that, the two never got unified —
// so a user following the OLD row sees a record (from `matches`) but zero
// "tournaments tracked" (players_games_tournaments only has the NEW row),
// exactly like MenaRD's Follow card showing 6-4 with "No tracked
// tournaments yet."
//
// Repoints every FK into players.id from legacyId to modernId across every
// table that references a player (see the table list below — kept in sync
// manually since SQLite has no information_schema to introspect this from),
// then deletes the now-empty legacy row. follows is handled specially: a
// blind UPDATE would violate the (user_id, player_id) UNIQUE constraint if
// a user already follows BOTH rows, so those are merged as INSERT OR IGNORE
// + DELETE instead.
//
// Usage:
//   node scripts/merge-duplicate-player.js <legacyId> <modernId> [--dry-run]

const db = require('../db/db');

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [legacyIdStr, modernIdStr] = args.filter((a) => !a.startsWith('--'));
  const legacyId = Number(legacyIdStr);
  const modernId = Number(modernIdStr);
  if (!Number.isInteger(legacyId) || !Number.isInteger(modernId) || legacyId === modernId) {
    fail('usage: node scripts/merge-duplicate-player.js <legacyId> <modernId> [--dry-run]');
  }

  const legacy = await db.getAsync('SELECT id, name, startgg_id FROM players WHERE id = ?', [legacyId]);
  const modern = await db.getAsync('SELECT id, name, startgg_id FROM players WHERE id = ?', [modernId]);
  if (!legacy) fail(`legacy player id ${legacyId} not found`);
  if (!modern) fail(`modern player id ${modernId} not found`);
  if (legacy.startgg_id != null) {
    fail(`legacy player ${legacyId} ("${legacy.name}") has a non-null startgg_id (${legacy.startgg_id}) — this script is for merging a startgg_id-less legacy row into a real one; refusing to touch a row that already has real start.gg identity`);
  }

  // Simple FK tables: a straight UPDATE is safe (no uniqueness constraint on
  // the player-id column in these tables).
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

  console.log(`Merging legacy player ${legacyId} ("${legacy.name}", startgg_id=null) -> modern player ${modernId} ("${modern.name}", startgg_id=${modern.startgg_id})`);

  const counts = {};
  for (const { table, cols } of simpleFkTables) {
    for (const col of cols) {
      const { c } = await db.getAsync(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`, [legacyId]);
      if (c > 0) counts[`${table}.${col}`] = c;
    }
  }
  const followRows = await db.allAsync('SELECT user_id FROM follows WHERE player_id = ?', [legacyId]);
  if (followRows.length) counts['follows.player_id'] = followRows.length;

  if (Object.keys(counts).length === 0) {
    console.log('Nothing references the legacy player — nothing to repoint. Will still delete the empty row.');
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
        await db.runAsync(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [modernId, legacyId]);
      }
    }
    // follows: merge instead of blind UPDATE so (user_id, player_id) UNIQUE
    // never conflicts if a user somehow already follows both rows.
    for (const { user_id } of followRows) {
      await db.runAsync('INSERT OR IGNORE INTO follows (user_id, player_id) VALUES (?, ?)', [user_id, modernId]);
    }
    await db.runAsync('DELETE FROM follows WHERE player_id = ?', [legacyId]);

    await db.runAsync('DELETE FROM players WHERE id = ?', [legacyId]);
    await db.runAsync('COMMIT');
    console.log(`Done. Player ${legacyId} merged into ${modernId} and removed.`);
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
