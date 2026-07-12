/**
 * One-shot cleanup for tournaments whose bracket_history was synced before
 * scripts/sync-live.js's resolveFinalPhase() fix. Before that fix, the
 * "final phase" (excluded from history - it's the live Top 8 bracket
 * instead) was picked as whichever phase had the highest phaseOrder. That
 * breaks when a tournament has a later-created phase (e.g. "Top 16") with a
 * higher phaseOrder than the phase literally named "Top 8" - the real Top 8
 * bracket's own rounds (Losers Final, Winners Final, Grand Final, ...) end
 * up stuck in bracket_history as duplicate/confusing pre-Top-8 "history".
 *
 * For every tournament+game currently tracked in bracket_history, this
 * deletes its rows (scoped by tournament_id - never a blanket wipe) and
 * re-derives them from Start.gg using the now-fixed phase selection. Safe to
 * run any time: bracket_history is purely derived, read-only display data -
 * no bets, odds, or settlement ever reference it. Idempotent: re-running
 * against already-correct data just re-derives the same rows.
 *
 * Self-contained (does not import the live poller), mirroring
 * backfill-bracket-history-2026.js.
 *
 * Usage:
 *   node scripts/cleanup-bracket-history-final-phase.js --dry-run   # report only, no writes
 *   node scripts/cleanup-bracket-history-final-phase.js             # delete + re-sync
 *   node scripts/cleanup-bracket-history-final-phase.js --limit=5   # first 5 tournaments only
 */
require('dotenv').config();
const db = require('../db/db');
const { startgg } = require('../startggClient');
const { findOrCreatePlayerId } = require('./lib/players');

const DRY = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const a = process.argv.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.split('=')[1], 10) : null;
})();

const SET_PAGE_SIZE = 15;
const MAX_SET_PAGES = 40;

const LIVE_PHASES = `
  query Phases($id: ID!) {
    tournament(id: $id) {
      events { id name videogame { id name } phases { id name phaseOrder } }
    }
  }`;

const PHASE_SETS = `
  query PhaseSets($eventId: ID!, $phaseId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      sets(page: $page, perPage: $perPage, filters: { phaseIds: [$phaseId] }) {
        pageInfo { totalPages }
        nodes {
          id state fullRoundText round winnerId
          phaseGroup { id }
          slots {
            entrant { id name participants { images { type url } player { id } } }
            standing { stats { score { value } } }
          }
        }
      }
    }
  }`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ_DELAY_MS = 800;
const MAX_RETRIES = 6;

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

// Mirrors sync-live.js resolveFinalPhase.
function resolveFinalPhase(phases = []) {
  const top8 = phases.find((p) => /top\s*8/i.test(p.name || ''));
  if (top8) return top8;
  return phases.reduce((a, b) => ((b.phaseOrder ?? 0) > (a.phaseOrder ?? 0) ? b : a));
}

async function fetchHistoryPhases(startggId) {
  const data = await ggRetry(LIVE_PHASES, { id: startggId });
  const events = data?.tournament?.events || [];
  const out = [];
  for (const ev of events) {
    const phases = ev.phases || [];
    if (phases.length < 2) continue;
    const finalPhase = resolveFinalPhase(phases);
    for (const phase of phases) {
      if (phase.id === finalPhase.id) continue;
      const nodes = await fetchPhaseSets(ev.id, phase.id);
      out.push({ videogame: ev.videogame, phaseOrder: phase.phaseOrder ?? 0, phaseName: phase.name, sets: nodes });
    }
  }
  return out;
}

function isPoolsPhase(name) {
  return /pool/i.test(name || '');
}

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

// findOrCreatePlayerId lives in ./lib/players — shared with every other
// ingestion script (see that module's doc comment for why: Entrant.id isn't
// a stable per-person identifier, Participant.player.id is).

const scoreOf = (slot) => { const v = slot?.standing?.stats?.score?.value; return v != null && v >= 0 ? v : 0; };

async function processHistorySets(tournamentId, gameId, roundGroups = []) {
  let written = 0;
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

      if (DRY) { written++; continue; }

      const p1Score = scoreOf(set.slots?.[0]);
      const p2Score = scoreOf(set.slots?.[1]);
      await db.runAsync(
        `INSERT INTO bracket_history
           (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_order,
            state, player1_id, player2_id, winner_id, player1_score, player2_score)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(startgg_set_id) DO UPDATE SET
           round_text=excluded.round_text, round_int=excluded.round_int, phase_order=excluded.phase_order,
           state=excluded.state, player1_id=excluded.player1_id, player2_id=excluded.player2_id,
           winner_id=excluded.winner_id, player1_score=excluded.player1_score, player2_score=excluded.player2_score,
           updated_at=CURRENT_TIMESTAMP`,
        [tournamentId, gameId, setId, group.roundText, group.roundInt, group.phaseOrder,
          state, p0, p1, winnerPid, p1Score, p2Score]
      );
      written++;
    }
  }
  return written;
}

async function main() {
  const targets = await db.allAsync(
    `SELECT DISTINCT bh.tournament_id, t.name, t.startgg_id
     FROM bracket_history bh
     JOIN tournaments t ON t.id = bh.tournament_id
     WHERE t.startgg_id IS NOT NULL
     ORDER BY bh.tournament_id`
  );
  const list = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log(`${DRY ? '[DRY-RUN] ' : ''}Re-syncing bracket_history for ${list.length} tournament(s)…`);

  let cleaned = 0, errors = 0;
  for (const t of list) {
    try {
      if (!DRY) {
        await db.runAsync('DELETE FROM bracket_history WHERE tournament_id = ?', [t.tournament_id]);
      }
      const historyPhases = await fetchHistoryPhases(t.startgg_id);
      const byGame = new Map();
      for (const phase of historyPhases) {
        if (!phase.videogame?.id) continue;
        const gameId = DRY ? -1 : await findOrCreateGameId(phase.videogame);
        if (!byGame.has(gameId)) byGame.set(gameId, { name: phase.videogame.name, phases: [] });
        byGame.get(gameId).phases.push(phase);
      }
      let totalWritten = 0;
      for (const [gameId, { name: gameName, phases }] of byGame) {
        const groups = groupSetsIntoRounds(phases);
        const written = await processHistorySets(t.tournament_id, gameId, groups);
        totalWritten += written;
        console.log(`  ✓ ${t.name} / ${gameName}: ${groups.length} round(s), ${written} set(s)`);
      }
      if (totalWritten > 0) cleaned++;
    } catch (err) {
      errors++;
      console.error(`  ✗ ${t.name} (sgg:${t.startgg_id}): ${err.message}`);
    }
  }
  console.log(`\nDone. tournaments=${list.length} cleaned=${cleaned} errors=${errors}`);
  process.exit(0);
}

main();
