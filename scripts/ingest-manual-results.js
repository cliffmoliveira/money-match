// Manually ingest results for a tournament that is NOT on start.gg (e.g. the
// Esports World Cup main stage, which runs on EWC's own platform). The daily
// start.gg sync can never discover these, so this script is the officially
// supported side door: it writes the same rows the sync pipeline would have —
// a tournaments row, tournament_games, settled set_markets for each set, and
// a matches row for the Grand Final (which feeds Home's Recent Champions) —
// so the event appears in Past Tournaments and past results like any other.
//
// Usage:
//   node scripts/ingest-manual-results.js data/manual-results/<event>.json [--dry-run]
//
// The JSON format is documented in docs/manual-results-ingestion.md. Key
// invariants enforced here:
//   - Players are resolved by EXACT name match against players.name and never
//     auto-created: a typo'd name must fail loudly (with suggestions) rather
//     than silently minting a duplicate player row.
//   - set_markets rows use startgg_set_id = 'manual-<manualId>-<n>' so reruns
//     are no-ops (same idea as the backfill's 'hist-' prefix) and the rows can
//     never collide with a real start.gg set id.
//   - The matches row key (matches.startgg_id) is a deterministic negative
//     hash of the manualId — negative so it can't collide with real start.gg
//     ids, deterministic so reruns update in place.
//   - No players_games_tournaments rows: that table drives futures odds, and
//     a hand-entered finished event must never surface as a bettable future.
//   - All markets are inserted pre-settled with zeroed pools/odds, matching
//     how backfill-top8-2026.js records historical sets nobody bet on.
//
// Optional `groupStages[]`: pre-Top-8 bracket progress (display only, see
// scripts/fetch-liquipedia-bracket.js). Writes bracket_history rows, never
// set_markets — no odds/pools/money, matches how the live poller treats
// every other tournament's own pool/qualifying stage. A missing score is
// allowed (bracket_history's score columns are nullable) as long as the
// winner is known; `sets[]` above has no such exception.
//
// `sets[]` is ALSO optional as long as `groupStages[]` is present: an event
// still in progress (its group stages finished, playoffs not yet played)
// can be ingested with groupStages[] only, so its bracket_history shows up
// right away instead of waiting on the whole event to conclude. Inserts the
// tournaments row with is_live=1 and no winner_id in that case (like a live
// synced tournament mid-pools). Re-running with sets[] once the Grand Final
// actually happens finalizes it (winner_id set, is_live=0, matches row
// written) - a groupStages-only re-run after that point leaves the existing
// is_live/winner_id alone, it only ever adds information, never retracts it.

const fs = require('fs');
const path = require('path');
const db = require('../db/db');

function fail(msg) {
  throw new Error(msg);
}

// Deterministic 31-bit hash (djb2), negated for synthetic matches.startgg_id.
function syntheticMatchId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return -(h % 0x7fffffff || 1);
}

async function resolvePlayer(name) {
  const rows = await db.allAsync('SELECT id, name FROM players WHERE name = ?', [name]);
  if (rows.length === 1) return rows[0].id;
  if (rows.length > 1) fail(`player name "${name}" is ambiguous in players table (ids ${rows.map((r) => r.id).join(', ')}) — disambiguate the DB first`);
  const near = await db.allAsync(
    "SELECT id, name FROM players WHERE name LIKE '%' || ? || '%' LIMIT 10",
    [name.split('|').pop().trim()]
  );
  fail(
    `player "${name}" not found (exact match required; players are never auto-created).` +
      (near.length ? ` Near matches: ${near.map((r) => `[${r.id}] ${r.name}`).join(' ; ')}` : '')
  );
}

// Core ingestion, callable directly with an already-parsed spec object (used
// by scripts/auto-sync-manual-events.js to ingest several events in one
// process run) as well as by main() below for the CLI/file-path usage.
// closeDb=false lets a multi-event caller keep the same db connection open
// across calls instead of main()'s one-shot CLI behavior of closing it.
async function ingestSpec(spec, { dryRun = false, closeDb = true } = {}) {
  const { manualId, tournament, game, numEntrants, sets = [], groupStages = [] } = spec;

  // ---- Validate the spec before touching anything ----
  if (!manualId || !/^[a-z0-9-]+$/.test(manualId)) fail('manualId is required (lowercase kebab-case)');
  if (!tournament?.name || !tournament?.date) fail('tournament.name and tournament.date are required');
  // sets[] (the Finals Bracket - committed, bettable-shape results) is OPTIONAL:
  // an event still in progress (its group stages done, playoffs not yet
  // played) can be ingested with only groupStages[] so its bracket_history
  // progress shows up immediately, same as a live-synced tournament's pool
  // stage - re-running later with sets[] once the Grand Final concludes
  // completes it (see the tournaments-row upsert below).
  if (sets.length === 0 && groupStages.length === 0) fail('at least one of sets[] or groupStages[] is required');
  if (Number.isNaN(Date.parse(tournament.date))) fail(`tournament.date does not parse: ${tournament.date}`);

  const gameRow = await db.getAsync('SELECT id, name FROM games WHERE name = ?', [game]);
  if (!gameRow) fail(`game "${game}" not found in games table (exact match required)`);

  const seen = new Set();
  for (const s of sets) {
    for (const k of ['n', 'round', 'roundInt', 'p1', 'p2']) {
      if (s[k] === undefined || s[k] === null) fail(`set #${s.n ?? '?'}: missing field "${k}"`);
    }
    if (seen.has(s.n)) fail(`duplicate set n=${s.n}`);
    seen.add(s.n);
    if (!Number.isInteger(s.p1Score) || !Number.isInteger(s.p2Score) || s.p1Score === s.p2Score) {
      fail(`set #${s.n}: p1Score/p2Score must be integers with a decisive winner`);
    }
  }
  const grandFinals = sets.filter((s) => s.round === 'Grand Final');
  if (sets.length > 0 && grandFinals.length !== 1) fail(`expected exactly 1 "Grand Final" set, found ${grandFinals.length}`);

  const gsSeen = new Set();
  for (const gs of groupStages) {
    for (const k of ['n', 'round', 'p1', 'p2']) {
      if (gs[k] === undefined || gs[k] === null) fail(`groupStages #${gs.n ?? '?'}: missing field "${k}"`);
    }
    if (gsSeen.has(gs.n)) fail(`duplicate groupStages n=${gs.n}`);
    gsSeen.add(gs.n);
    if (gs.winner !== 1 && gs.winner !== 2) fail(`groupStages #${gs.n}: winner must be 1 or 2 (got ${JSON.stringify(gs.winner)})`);
  }

  // Resolve every player up front so a bad name aborts before any write.
  const playerIds = new Map();
  for (const s of sets) {
    for (const name of [s.p1, s.p2]) {
      if (!playerIds.has(name)) playerIds.set(name, await resolvePlayer(name));
    }
  }
  for (const gs of groupStages) {
    for (const name of [gs.p1, gs.p2]) {
      if (!playerIds.has(name)) playerIds.set(name, await resolvePlayer(name));
    }
  }

  const gf = grandFinals[0] || null;
  const gfWinnerName = gf ? (gf.p1Score > gf.p2Score ? gf.p1 : gf.p2) : null;
  const gfLoserName = gf ? (gf.p1Score > gf.p2Score ? gf.p2 : gf.p1) : null;
  const gfWinnerScore = gf ? Math.max(gf.p1Score, gf.p2Score) : null;
  const gfLoserScore = gf ? Math.min(gf.p1Score, gf.p2Score) : null;

  console.log(`Event: ${tournament.name} (${tournament.date}) — ${gameRow.name}`);
  if (gf) {
    console.log(`Champion: ${gfWinnerName} def. ${gfLoserName} ${gfWinnerScore}-${gfLoserScore}`);
  } else {
    console.log(`Still in progress (no Grand Final in this spec) - ${groupStages.length} group-stage rows only.`);
  }
  console.log(`${sets.length} sets, players: ${[...playerIds.keys()].join(', ')}`);
  if (dryRun) {
    console.log('--dry-run: no writes performed.');
    if (closeDb) await db.closeAsync();
    return { dryRun: true };
  }

  await db.runAsync('BEGIN');
  try {
    // ---- tournaments row (find by exact name, else insert) ----
    let tRow = await db.getAsync('SELECT id FROM tournaments WHERE name = ?', [tournament.name]);
    const winnerId = gf ? playerIds.get(gfWinnerName) : null;
    if (tRow) {
      if (gf) {
        // A complete Grand Final in this run is authoritative - finalize
        // the event even if it was previously ingested groupStages-only.
        await db.runAsync(
          'UPDATE tournaments SET date=?, city=?, country=?, logo_url=COALESCE(?, logo_url), winner_id=?, is_live=0 WHERE id=?',
          [tournament.date, tournament.city || null, tournament.country || null, tournament.logoUrl || null, winnerId, tRow.id]
        );
      } else {
        // groupStages-only progress update - don't touch is_live/winner_id,
        // there's no new information here about whether the event finished.
        await db.runAsync(
          'UPDATE tournaments SET date=?, city=?, country=?, logo_url=COALESCE(?, logo_url) WHERE id=?',
          [tournament.date, tournament.city || null, tournament.country || null, tournament.logoUrl || null, tRow.id]
        );
      }
      console.log(`tournaments: updated existing id ${tRow.id}`);
    } else {
      // First time this event is ingested: is_live=1 (still ongoing) unless
      // a complete Grand Final is already in this spec.
      const r = await db.runAsync(
        'INSERT INTO tournaments (name, date, city, country, winner_id, startgg_id, logo_url, is_live) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        [tournament.name, tournament.date, tournament.city || null, tournament.country || null, winnerId, tournament.logoUrl || null, gf ? 0 : 1]
      );
      tRow = { id: r.lastID };
      console.log(`tournaments: inserted id ${tRow.id}`);
    }

    // ---- tournament_games (game pill + entrant count on cards) ----
    const tg = await db.getAsync('SELECT rowid FROM tournament_games WHERE tournament_id=? AND game_id=?', [tRow.id, gameRow.id]);
    if (tg) {
      await db.runAsync('UPDATE tournament_games SET num_entrants=? WHERE tournament_id=? AND game_id=?', [numEntrants ?? null, tRow.id, gameRow.id]);
    } else {
      await db.runAsync('INSERT INTO tournament_games (tournament_id, game_id, num_entrants) VALUES (?, ?, ?)', [tRow.id, gameRow.id, numEntrants ?? null]);
    }

    // ---- one settled set_market per set ----
    let inserted = 0, skipped = 0;
    for (const s of sets) {
      const setKey = `manual-${manualId}-${s.n}`;
      const exists = await db.getAsync('SELECT id FROM set_markets WHERE startgg_set_id = ?', [setKey]);
      if (exists) { skipped++; continue; }
      const p1 = playerIds.get(s.p1);
      const p2 = playerIds.get(s.p2);
      const winner = s.p1Score > s.p2Score ? p1 : p2;
      const at = s.at || tournament.date;
      await db.runAsync(
        `INSERT INTO set_markets (tournament_id, game_id, startgg_set_id, round_text, player1_id, player2_id,
           state, p1_prob, p2_prob, seed_k_cents, p1_pool_cents, p2_pool_cents, p1_live_odds, p2_live_odds,
           winner_id, opened_at, closed_at, settled_at, round_int, p1_score, p2_score)
         VALUES (?, ?, ?, ?, ?, ?, 'settled', 0.5, 0.5, 0, 0, 0, 0, 0, ?, ?, NULL, ?, ?, ?, ?)`,
        [tRow.id, gameRow.id, setKey, s.round, p1, p2, winner, at, at, s.roundInt, s.p1Score, s.p2Score]
      );
      inserted++;
    }
    console.log(`set_markets: ${inserted} inserted, ${skipped} already present`);

    // ---- bracket_history rows for pre-Top-8 group-stage progress (display
    // only - never opens a market, never carries money, same as every
    // synced tournament's own pool/qualifying stage) ----
    let gsWritten = 0;
    for (const gs of groupStages) {
      const setKey = `manual-${manualId}-gs-${gs.n}`;
      const p1 = playerIds.get(gs.p1);
      const p2 = playerIds.get(gs.p2);
      const winner = gs.winner === 1 ? p1 : p2;
      const existing = await db.getAsync('SELECT id FROM bracket_history WHERE startgg_set_id = ?', [setKey]);
      if (existing) {
        await db.runAsync(
          `UPDATE bracket_history SET round_text=?, round_int=NULL, phase_order=?, state='completed',
             player1_id=?, player2_id=?, winner_id=?, player1_score=?, player2_score=? WHERE id=?`,
          [gs.round, gs.phaseOrder ?? null, p1, p2, winner, gs.p1Score ?? null, gs.p2Score ?? null, existing.id]
        );
      } else {
        await db.runAsync(
          `INSERT INTO bracket_history
             (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_order, state,
              player1_id, player2_id, winner_id, player1_score, player2_score)
           VALUES (?, ?, ?, ?, NULL, ?, 'completed', ?, ?, ?, ?, ?)`,
          [tRow.id, gameRow.id, setKey, gs.round, gs.phaseOrder ?? null, p1, p2, winner, gs.p1Score ?? null, gs.p2Score ?? null]
        );
      }
      gsWritten++;
    }
    if (groupStages.length) console.log(`bracket_history: ${gsWritten} group-stage rows written`);

    // ---- Grand Final matches row (Home "Recent Champions" feed) - only
    // once the event has actually concluded ----
    if (gf) {
      const matchKey = syntheticMatchId(`manual-${manualId}`);
      const existingMatch = await db.getAsync('SELECT id FROM matches WHERE startgg_id = ?', [matchKey]);
      const w = playerIds.get(gfWinnerName);
      const l = playerIds.get(gfLoserName);
      if (existingMatch) {
        await db.runAsync(
          `UPDATE matches SET tournament_id=?, game_id=?, player1_id=?, player2_id=?, winner_id=?, loser_id=?,
           player1RoundsWon=?, player2RoundsWon=? WHERE id=?`,
          [tRow.id, gameRow.id, w, l, w, l, gfWinnerScore, gfLoserScore, existingMatch.id]
        );
        console.log(`matches: updated existing id ${existingMatch.id}`);
      } else {
        await db.runAsync(
          `INSERT INTO matches (tournament_id, game_id, player1_id, player2_id, winner_id, loser_id,
           player1RoundsWon, player2RoundsWon, startgg_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [tRow.id, gameRow.id, w, l, w, l, gfWinnerScore, gfLoserScore, matchKey]
        );
        console.log(`matches: inserted Grand Final (synthetic startgg_id ${matchKey})`);
      }
    }

    await db.runAsync('COMMIT');
    console.log(`Done. Tournament id ${tRow.id} — "${tournament.name}" is now in past results.`);
    if (closeDb) await db.closeAsync();
    return { tournamentId: tRow.id, finalized: !!gf };
  } catch (err) {
    await db.runAsync('ROLLBACK');
    if (closeDb) await db.closeAsync();
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) fail('usage: node scripts/ingest-manual-results.js <data.json> [--dry-run]');
  const spec = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return ingestSpec(spec, { dryRun });
}

module.exports = { main, ingestSpec, resolvePlayer };

if (require.main === module) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
