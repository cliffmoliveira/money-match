/**
 * Phase 2 of the legacy-duplicate-player cleanup: executes the plan written
 * by plan-legacy-player-merges.js (scripts/.legacy-merge-plan.json).
 *
 * For every "ready" cluster, merges all of its mergeIds into survivorId —
 * a generalized version of merge-duplicate-player.js's pairwise merge (some
 * clusters collapse 3+ rows: the legacy bare-name row plus multiple modern
 * rows that turned out to share the same real Start.gg player.id, e.g. a
 * player whose sponsor changed twice). Also applies each cluster's
 * "ambiguous" subMerges — same-identity modern-row dupes that were provably
 * safe to collapse even though the legacy row itself was left unattached
 * (see plan-legacy-player-merges.js's doc comment for why).
 *
 * After merging, sets the survivor's startgg_id to the plan's
 * verifiedPlayerId — closing the loop immediately instead of waiting for a
 * future sync touch to self-heal it.
 *
 * Repoints every FK into players.id exactly like merge-duplicate-player.js
 * (see that script for the full table list / follows-conflict handling);
 * kept as a local copy here since this operates on N ids per cluster, not a
 * single pair.
 *
 * Usage:
 *   node scripts/apply-legacy-player-merges.js --dry-run
 *   node scripts/apply-legacy-player-merges.js
 */
const fs = require('fs');
const path = require('path');
const db = require('../db/db');

const PLAN_FILE = path.join(__dirname, '.legacy-merge-plan.json');

// Tables with no unique constraint on the FK column(s) being repointed — a
// plain UPDATE can't collide.
const SIMPLE_FK_TABLES = [
  { table: 'matches', cols: ['player1_id', 'player2_id', 'winner_id', 'loser_id'] },
  { table: 'tournaments', cols: ['winner_id'] },
  { table: 'set_markets', cols: ['player1_id', 'player2_id', 'winner_id'] },
  { table: 'set_bets', cols: ['picked_player_id'] },
  { table: 'pickem_picks', cols: ['picked_player_id'] },
  { table: 'parlay_legs', cols: ['player_id'] },
  { table: 'bracket_history', cols: ['player1_id', 'player2_id', 'winner_id'] },
];

// Tables where player_id is part of a table-level UNIQUE constraint, so a
// blind UPDATE can collide if the survivor already has an equivalent row
// (e.g. both the legacy and modern rows have a players_games_tournaments
// entry for the same tournament+game — confirmed happens at least once in
// this cleanup: "Wawa"). For these, delete the source's row instead of
// repointing it whenever the survivor already covers the same key —
// dropping the redundant duplicate is correct: the survivor's row already
// represents that same real participation.
const UNIQUE_FK_TABLES = [
  { table: 'players_games_tournaments', col: 'player_id', matchCols: ['tournament_id', 'game_id'] },
  { table: 'bets', col: 'player_id', matchCols: ['user_id', 'tournament_id', 'game_id'] },
];

async function mergeInto(sourceIds, destId, { setStartggId = null } = {}) {
  const counts = {};
  for (const srcId of sourceIds) {
    for (const { table, cols } of SIMPLE_FK_TABLES) {
      for (const col of cols) {
        const { c } = await db.getAsync(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?`, [srcId]);
        if (c > 0) counts[`${table}.${col}`] = (counts[`${table}.${col}`] || 0) + c;
      }
    }
    for (const { table, col, matchCols } of UNIQUE_FK_TABLES) {
      const rows = await db.allAsync(`SELECT * FROM ${table} WHERE ${col} = ?`, [srcId]);
      for (const row of rows) {
        const where = matchCols.map((c) => `${c} = ?`).join(' AND ');
        const dupe = await db.getAsync(`SELECT 1 FROM ${table} WHERE ${col} = ? AND ${where}`, [destId, ...matchCols.map((c) => row[c])]);
        const key = dupe ? `${table}.${col} (dropped as redundant dupe)` : `${table}.${col}`;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }
  const followRows = [];
  for (const srcId of sourceIds) {
    followRows.push(...(await db.allAsync('SELECT user_id FROM follows WHERE player_id = ?', [srcId])).map((r) => r.user_id));
  }
  if (followRows.length) counts['follows.player_id'] = followRows.length;

  return {
    counts,
    apply: async () => {
      await db.runAsync('BEGIN');
      try {
        for (const srcId of sourceIds) {
          for (const { table, cols } of SIMPLE_FK_TABLES) {
            for (const col of cols) {
              await db.runAsync(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [destId, srcId]);
            }
          }
          for (const { table, col, matchCols } of UNIQUE_FK_TABLES) {
            const rows = await db.allAsync(`SELECT * FROM ${table} WHERE ${col} = ?`, [srcId]);
            for (const row of rows) {
              const where = matchCols.map((c) => `${c} = ?`).join(' AND ');
              const dupe = await db.getAsync(`SELECT id FROM ${table} WHERE ${col} = ? AND ${where}`, [destId, ...matchCols.map((c) => row[c])]);
              if (dupe) {
                // Survivor already has an equivalent row — drop the source's
                // redundant one instead of repointing into a UNIQUE conflict.
                await db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [row.id]);
              } else {
                await db.runAsync(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, [destId, row.id]);
              }
            }
          }
        }
        for (const userId of followRows) {
          await db.runAsync('INSERT OR IGNORE INTO follows (user_id, player_id) VALUES (?, ?)', [userId, destId]);
        }
        for (const srcId of sourceIds) {
          await db.runAsync('DELETE FROM follows WHERE player_id = ?', [srcId]);
          await db.runAsync('DELETE FROM players WHERE id = ?', [srcId]);
        }
        if (setStartggId != null) {
          await db.runAsync('UPDATE players SET startgg_id = ? WHERE id = ?', [setStartggId, destId]);
        }
        await db.runAsync('COMMIT');
      } catch (err) {
        await db.runAsync('ROLLBACK');
        throw err;
      }
    },
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!fs.existsSync(PLAN_FILE)) {
    console.error(`No plan file at ${PLAN_FILE} — run scripts/plan-legacy-player-merges.js first.`);
    process.exit(1);
  }
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));

  // Re-runnable: a cluster whose source ids are all already gone (merged by
  // a prior run of this script) is skipped rather than re-attempted — lets
  // this recover cleanly from a partial run instead of erroring on rows
  // that no longer exist.
  const stillExists = async (id) => !!(await db.getAsync('SELECT id FROM players WHERE id = ?', [id]));

  let applied = 0, skipped = 0, failed = 0;
  for (const cluster of plan) {
    if (cluster.status === 'ready') {
      const sourceIds = cluster.mergeIds.filter((id) => id !== cluster.survivorId);
      if (!dryRun && !(await stillExists(sourceIds[0]))) {
        console.log(`[already-merged] ${cluster.legacyName} (id ${cluster.legacyId}) — skipping, a prior run already merged this cluster.`);
        continue;
      }
      const { counts, apply } = await mergeInto(sourceIds, cluster.survivorId, { setStartggId: cluster.verifiedPlayerId });
      console.log(`[ready] ${cluster.legacyName} + ${sourceIds.length - 1} modern dup(s) -> survivor ${cluster.survivorId} ("${cluster.survivorName}", player.id ${cluster.verifiedPlayerId}). Repointing: ${JSON.stringify(counts)}`);
      try {
        if (!dryRun) await apply();
        applied++;
      } catch (err) {
        console.log(`  [FAILED, rolled back, continuing] ${cluster.legacyName}: ${err.message}`);
        failed++;
      }
    } else if (cluster.status === 'ambiguous' && cluster.subMerges?.length) {
      for (const sub of cluster.subMerges) {
        const sourceIds = sub.mergeIds.filter((id) => id !== sub.survivorId);
        if (!dryRun && !(await stillExists(sourceIds[0]))) {
          console.log(`[already-merged] ${cluster.legacyName} submerge (survivor ${sub.survivorId}) — skipping, a prior run already merged this.`);
          continue;
        }
        const { counts, apply } = await mergeInto(sourceIds, sub.survivorId, { setStartggId: sub.verifiedPlayerId });
        console.log(`[ambiguous-submerge] ${cluster.legacyName} cluster: ${sourceIds.length} same-identity dup(s) -> survivor ${sub.survivorId} ("${sub.survivorName}", player.id ${sub.verifiedPlayerId}) — legacy row ${cluster.legacyId} left untouched. Repointing: ${JSON.stringify(counts)}`);
        try {
          if (!dryRun) await apply();
          applied++;
        } catch (err) {
          console.log(`  [FAILED, rolled back, continuing] ${cluster.legacyName} submerge: ${err.message}`);
          failed++;
        }
      }
      console.log(`[ambiguous] ${cluster.legacyName} (id ${cluster.legacyId}) left unmerged: ${cluster.reason}`);
      skipped++;
    } else {
      console.log(`[${cluster.status}] ${cluster.legacyName} (id ${cluster.legacyId}) skipped: ${cluster.reason}`);
      skipped++;
    }
  }

  console.log(`\n${dryRun ? '--dry-run: no writes performed. ' : ''}${applied} merge(s) ${dryRun ? 'would be' : 'were'} applied, ${skipped} cluster(s) need manual review or had nothing to merge, ${failed} failed (rolled back, safe to investigate and re-run).`);
  await db.closeAsync();
}

main().catch((err) => {
  console.error('Apply failed:', err);
  process.exit(1);
});
