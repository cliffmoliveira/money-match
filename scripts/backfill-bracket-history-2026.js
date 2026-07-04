/**
 * One-shot historical Bracket Tracker backfill for past 2026 events.
 *
 * Pulls each past 2026 tournament's non-final-phase sets (Pools, Winners/Losers
 * Round N, ...) from Start.gg and writes them into bracket_history — the same
 * read-only table scripts/sync-live.js's live history pass writes to going
 * forward. Self-contained (does NOT import the live poller) and idempotent
 * (upsert on the unique startgg_set_id), mirroring backfill-top8-2026.js.
 *
 * Usage:
 *   node scripts/backfill-bracket-history-2026.js --dry-run     # report only, no writes
 *   node scripts/backfill-bracket-history-2026.js               # write bracket_history rows
 *   node scripts/backfill-bracket-history-2026.js --limit=5     # first 5 tournaments only
 */
require('dotenv').config();
const db = require('../db/db');
const { startgg } = require('../startggClient');

const DRY = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const a = process.argv.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();

// Early rounds (Round 1/2 pools) at big multi-hundred-entrant events blow
// Start.gg's 1000-object query complexity cap at the full field selection +
// perPage 50 (confirmed against Evo 2026: every Round 1/2 phase failed at
// ~1050-1250 actual). History rows don't need `seeds` (only the live Top 8
// path reads that), so drop it and fetch smaller pages — mirrors the same
// fix in scripts/sync-live.js's fetchHistoryPhaseSets.
const SET_PAGE_SIZE = 15;
const MAX_SET_PAGES = 40; // covers a ~600-set Round 1 at a 1000+ entrant event

// Mirrors sync-live.js LIVE_PHASES (needs phase name too, to tell pools apart
// from bracket rounds).
const LIVE_PHASES = `
  query Phases($id: ID!) {
    tournament(id: $id) {
      events { id name videogame { id name } phases { id name phaseOrder } }
    }
  }`;

// Mirrors sync-live.js HISTORY_PHASE_SETS (lighter than the live Top 8 path's
// PHASE_SETS: no `seeds`, smaller perPage — see comment on SET_PAGE_SIZE above).
const PHASE_SETS = `
  query PhaseSets($eventId: ID!, $phaseId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      sets(page: $page, perPage: $perPage, filters: { phaseIds: [$phaseId] }) {
        pageInfo { totalPages }
        nodes {
          id state fullRoundText round winnerId
          phaseGroup { id }
          slots {
            entrant { id name participants { images { type url } } }
            standing { stats { score { value } } }
          }
        }
      }
    }
  }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ_DELAY_MS = 800; // proactive pacing — Start.gg caps at ~80 requests/minute
const MAX_RETRIES = 6;

// Throttled Start.gg call: paces every request and backs off on HTTP 429 so a
// bulk historical load across many tournaments/phases doesn't trip the rate
// limiter (which the live poller, ticking one tournament at a time every 60s,
// never hits).
async function ggRetry(query, vars) {
  for (let attempt = 0; ; attempt++) {
    await sleep(REQ_DELAY_MS);
    try {
      return await startgg(query, vars);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(err?.response?.headers?.['retry-after']);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60000, 5000 * 2 ** attempt);
        console.log(`    …429 rate-limited; waiting ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

// Page through a phase's sets (mirrors sync-live.js fetchPhaseSets).
async function fetchPhaseSets(eventId, phaseId) {
  const all = [];
  for (let page = 1; page <= MAX_SET_PAGES; page++) {
    const data = await ggRetry(PHASE_SETS, { eventId, phaseId, page, perPage: SET_PAGE_SIZE });
    const nodes = data?.event?.sets?.nodes || [];
    all.push(...nodes);
    const totalPages = data?.event?.sets?.pageInfo?.totalPages || 1;
    if (nodes.length < SET_PAGE_SIZE || page >= totalPages) break;
  }
  return all;
}

// Sets from every phase EXCEPT the final one (backfill-top8-2026.js already
// covers the final/Top-8 phase). Mirrors sync-live.js fetchHistoryPhases.
async function fetchHistoryPhases(startggId) {
  const data = await ggRetry(LIVE_PHASES, { id: startggId });
  const events = data?.tournament?.events || [];
  const out = [];
  for (const ev of events) {
    const phases = ev.phases || [];
    if (phases.length < 2) continue; // nothing before the final phase to track
    const finalPhase = phases.reduce((a, b) => ((b.phaseOrder ?? 0) > (a.phaseOrder ?? 0) ? b : a));
    for (const phase of phases) {
      if (phase.id === finalPhase.id) continue;
      const nodes = await fetchPhaseSets(ev.id, phase.id);
      out.push({ videogame: ev.videogame, phaseOrder: phase.phaseOrder ?? 0, phaseName: phase.name, sets: nodes });
    }
  }
  return out;
}

// Mirrors sync-live.js isPoolsPhase.
function isPoolsPhase(name) {
  return /pool/i.test(name || '');
}

// Mirrors sync-live.js groupSetsIntoRounds.
function groupSetsIntoRounds(historyPhases = []) {
  const byRoundText = new Map();
  let poolsPhaseOrder = null;

  for (const phase of historyPhases) {
    if (isPoolsPhase(phase.phaseName)) {
      if (poolsPhaseOrder === null || phase.phaseOrder < poolsPhaseOrder) poolsPhaseOrder = phase.phaseOrder;
      const key = 'Pools';
      if (!byRoundText.has(key)) byRoundText.set(key, { roundText: 'Pools', roundInt: null, phaseOrder: phase.phaseOrder, sets: [] });
      byRoundText.get(key).sets.push(...phase.sets);
      continue;
    }
    for (const set of phase.sets) {
      const key = set.fullRoundText || `phase-${phase.phaseOrder}`;
      if (!byRoundText.has(key)) {
        byRoundText.set(key, { roundText: key, roundInt: set.round ?? null, phaseOrder: phase.phaseOrder, sets: [] });
      }
      byRoundText.get(key).sets.push(set);
    }
  }

  const groups = [...byRoundText.values()];
  const pools = groups.find((g) => g.roundText === 'Pools');
  if (pools && poolsPhaseOrder !== null) pools.phaseOrder = poolsPhaseOrder;
  return groups;
}

async function findOrCreateGameId(vg) {
  const existing = await db.getAsync('SELECT id FROM games WHERE startgg_id = ? OR name = ?', [vg.id, vg.name]);
  if (existing) return existing.id;
  const res = await db.runAsync('INSERT INTO games (name, startgg_id) VALUES (?, ?)', [vg.name, vg.id]);
  return res.lastID;
}

// A participant's uploaded start.gg profile photo. Optional per player — many
// entrants never upload one.
const photoOf = (entrant) => entrant?.participants?.[0]?.images?.find((i) => i.type === 'profile')?.url || null;

async function findOrCreatePlayerId(entrant) {
  const name = entrant?.name?.trim();
  if (!name) return null;
  const photoUrl = photoOf(entrant);
  const existing = await db.getAsync('SELECT id FROM players WHERE startgg_id = ? OR name = ?', [entrant.id, name]);
  if (existing) {
    await db.runAsync(
      'UPDATE players SET startgg_id = COALESCE(startgg_id, ?), photo_url = COALESCE(?, photo_url) WHERE id = ?',
      [entrant.id, photoUrl, existing.id]
    );
    return existing.id;
  }
  const res = await db.runAsync('INSERT INTO players (name, country, startgg_id, photo_url) VALUES (?, ?, ?, ?)', [name, '', entrant.id, photoUrl]);
  return res.lastID;
}

const scoreOf = (slot) => { const v = slot?.standing?.stats?.score?.value; return v != null && v >= 0 ? v : 0; };

// Writes grouped round data into bracket_history — one row per Start.gg set,
// upserted by startgg_set_id. Mirrors sync-live.js processHistorySets exactly
// (same table, same upsert-by-id contract), so a tournament that later
// becomes live and gets picked up by the regular poller just updates these
// same rows in place rather than duplicating them.
async function processHistorySets(tournamentId, gameId, roundGroups = []) {
  const stats = { created: 0, updated: 0 };
  for (const group of roundGroups) {
    for (const set of group.sets) {
      const e0 = set.slots?.[0]?.entrant;
      const e1 = set.slots?.[1]?.entrant;
      const setId = String(set.id);
      const state = set.state === 3 ? 'completed' : set.state === 2 ? 'in_progress' : 'pending';

      let p0 = null, p1 = null, winnerPid = null;
      if (e0?.id) p0 = await findOrCreatePlayerId(e0);
      if (e1?.id) p1 = await findOrCreatePlayerId(e1);
      if (set.state === 3 && set.winnerId != null) {
        const winnerEntrant = set.winnerId === e0?.id ? e0 : e1;
        if (winnerEntrant) winnerPid = await findOrCreatePlayerId(winnerEntrant);
      }

      if (DRY) { stats.created++; continue; }

      const existing = await db.getAsync('SELECT id FROM bracket_history WHERE startgg_set_id = ?', [setId]);
      const p1Score = scoreOf(set.slots?.[0]);
      const p2Score = scoreOf(set.slots?.[1]);
      if (existing) {
        await db.runAsync(
          `UPDATE bracket_history SET
             round_text=?, round_int=?, phase_order=?, state=?,
             player1_id=?, player2_id=?, winner_id=?, player1_score=?, player2_score=?,
             updated_at=CURRENT_TIMESTAMP
           WHERE startgg_set_id=?`,
          [group.roundText, group.roundInt, group.phaseOrder, state, p0, p1, winnerPid, p1Score, p2Score, setId]
        );
        stats.updated++;
      } else {
        await db.runAsync(
          `INSERT INTO bracket_history
             (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_order,
              state, player1_id, player2_id, winner_id, player1_score, player2_score)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [tournamentId, gameId, setId, group.roundText, group.roundInt, group.phaseOrder,
            state, p0, p1, winnerPid, p1Score, p2Score]
        );
        stats.created++;
      }
    }
  }
  return stats;
}

async function main() {
  const tournaments = await db.allAsync(
    `SELECT id, name, startgg_id, date FROM tournaments
     WHERE strftime('%Y', date) = '2026' AND date(date) < date('now') AND startgg_id IS NOT NULL
     ORDER BY date DESC`
  );
  const list = LIMIT ? tournaments.slice(0, LIMIT) : tournaments;
  console.log(`${DRY ? '[DRY-RUN] ' : ''}Backfilling bracket history for ${list.length} past 2026 tournaments…`);

  let created = 0, updated = 0, eventsSeen = 0, errors = 0;
  for (const t of list) {
    try {
      const historyPhases = await fetchHistoryPhases(t.startgg_id);
      if (!historyPhases.length) { console.log(`  · ${t.name}: no non-final phases (single-phase event)`); continue; }

      const byGame = new Map();
      for (const phase of historyPhases) {
        if (!phase.videogame?.id) continue;
        const gameId = DRY ? -1 : await findOrCreateGameId(phase.videogame);
        if (!byGame.has(gameId)) byGame.set(gameId, { name: phase.videogame.name, phases: [] });
        byGame.get(gameId).phases.push(phase);
      }

      for (const [gameId, { name: gameName, phases }] of byGame) {
        eventsSeen++;
        const groups = groupSetsIntoRounds(phases);
        const totalSets = groups.reduce((n, g) => n + g.sets.length, 0);
        if (!totalSets) { console.log(`  · ${t.name} / ${gameName}: no tracked sets`); continue; }
        const r = await processHistorySets(t.id, gameId, groups);
        created += r.created; updated += r.updated;
        console.log(`  ✓ ${t.name} / ${gameName}: ${groups.length} round(s), ${totalSets} set(s)`);
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ ${t.name} (sgg:${t.startgg_id}): ${err.message}`);
    }
  }
  console.log(`\nDone. events=${eventsSeen} created=${created} updated=${updated} errors=${errors}`);
  process.exit(0);
}

main();
