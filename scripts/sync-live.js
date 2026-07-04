/**
 * Live poller: turns Start.gg Top 8 sets into bettable markets and drives their
 * lifecycle. For each active tournament it resolves each event's finals phase,
 * pulls that phase's sets (all states), and:
 *   state 1 (upcoming, both entrants known) -> ensure an OPEN market
 *   state 2 (in progress)                   -> CLOSE the market (betting stops)
 *   state 3 (completed, has winner)         -> SETTLE the market
 *
 * Scope is Top 8 rounds only. Odds/settlement live in liveMarkets.js.
 *
 * Usage:
 *   node scripts/sync-live.js                 # poll all active tournaments once
 *   node scripts/sync-live.js --all           # ignore active filter (debug)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');
const { startgg } = require('../startggClient');
const lm = require('../liveMarkets');

// The Top 8 lives in an event's FINAL phase (highest phaseOrder). Resolve that
// phase first (LIVE_PHASES), then pull only its sets (PHASE_SETS), paginated —
// so detection holds even for majors whose thousands of pools sets would never
// fit in one page of the event-wide set list.
const LIVE_PHASES = `
query LivePhases($id: ID!) {
  tournament(id: $id) {
    id name
    events {
      id name videogame { id name }
      phases { id name phaseOrder }
    }
  }
}`;

const PHASE_SETS = `
query PhaseSets($eventId: ID!, $phaseId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    id
    sets(page: $page, perPage: $perPage, sortType: STANDARD, filters: { phaseIds: [$phaseId] }) {
      pageInfo { totalPages }
      nodes {
        id state fullRoundText winnerId round
        phaseGroup { id }
        slots {
          entrant { id name seeds { seedNum } participants { images { type url } } }
          standing { stats { score { value } } }
        }
      }
    }
  }
}`;

const SET_PAGE_SIZE = 50;
const MAX_SET_PAGES = 6; // a Top 8 phase is small; cap to bound a pathological event

// Early rounds (Round 1/2 pools) at big multi-hundred-entrant events blow
// Start.gg's 1000-object query complexity cap at PHASE_SETS' full field
// selection + perPage 50 (confirmed against Evo 2026: every Round 1/2 phase
// failed at ~1050-1250). History tracking doesn't need `seeds` (only the Top
// 8 path's seedOf() reads that), so drop it and fetch smaller pages to stay
// well under the cap even as brackets grow.
const HISTORY_SET_PAGE_SIZE = 15;
const MAX_HISTORY_SET_PAGES = 40; // covers a ~600-set Round 1 at a 1000+ entrant event
const HISTORY_PHASE_SETS = `
query HistoryPhaseSets($eventId: ID!, $phaseId: ID!, $page: Int!, $perPage: Int!) {
  event(id: $eventId) {
    id
    sets(page: $page, perPage: $perPage, sortType: STANDARD, filters: { phaseIds: [$phaseId] }) {
      pageInfo { totalPages }
      nodes {
        id state fullRoundText winnerId round
        phaseGroup { id }
        slots {
          entrant { id name participants { images { type url } } }
          standing { stats { score { value } } }
        }
      }
    }
  }
}`;

// Canonical double-elim Top 8: Winners Semi-Final & Final, Losers Quarter-Final,
// Semi-Final & Final, Grand Final (+ reset). Match exact round names after
// normalizing separators so "Quarter-Final" isn't caught by a loose "final".
const TOP8_ROUNDS = [
  /grand final/,          // also covers "grand final reset"
  /winners final/,
  /winners semi final/,
  /losers final/,
  /losers semi final/,
  /losers quarter final/,
];
function isTop8Round(text) {
  const n = (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return TOP8_ROUNDS.some((re) => re.test(n));
}

// A "Pools" (or "Pool A"/"Pool B"/...) phase collapses into a single synthetic
// "Pools" round in the tracker instead of listing every individual pool round
// — large events can have dozens, and the useful granularity there is "are
// pools done yet," not which specific pool.
function isPoolsPhase(name) {
  return /pool/i.test(name || '');
}

// Resolves an event's TRUE final phase. Start.gg's own phaseOrder doesn't
// always track chronological/structural order — a later-created "Top 16"
// consolidation phase can end up with a HIGHER phaseOrder than the phase
// literally named "Top 8", even though "Top 8" is the real final stage.
// Confirmed against a real event where "Top 16" (phaseOrder 3) outranked the
// actual "Top 8" phase (phaseOrder 2), which caused the genuine Top 8 bracket
// to be misclassified as pre-Top-8 history instead of the live money market.
// Falls back to highest phaseOrder when no phase is named "Top 8" (the
// original heuristic, still correct for every ordinary tournament).
function resolveFinalPhase(phases = []) {
  const top8 = phases.find((p) => /top\s*8/i.test(p.name || ''));
  if (top8) return top8;
  return phases.reduce((a, b) => ((b.phaseOrder ?? 0) > (a.phaseOrder ?? 0) ? b : a));
}

// "done" once every set in the round has reported a winner (state 3); "live"
// once at least one set has started (state 2) or finished while others
// haven't; "next" when every set is still state 1 (pending) — start.gg
// generates the full bracket shell, sets and all, long before a tournament's
// early rounds actually start, so without this a freshly-tracked bracket
// would show every future round as "live" from the moment it's first synced.
function classifyRoundStatus(sets = []) {
  if (sets.length > 0 && sets.every((s) => s.state === 3)) return 'done';
  if (sets.some((s) => s.state === 2 || s.state === 3)) return 'live';
  return 'next';
}

// Turns the per-phase set lists from fetchHistoryPhases() into the round
// buckets the tracker displays: every pools phase collapses into one
// synthetic "Pools" group (roundInt: null, phaseOrder = the lowest pools
// phaseOrder seen), while bracket-phase sets group by their own round text
// (start.gg reports the same fullRoundText/round for every set in a round).
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

const seedOf = (entrant) => entrant?.seeds?.[0]?.seedNum ?? null;
const scoreOf = (slot) => {
  const v = slot?.standing?.stats?.score?.value;
  return v == null || v < 0 ? 0 : v;
};
const isGrandFinal = (text) => (text || '').toLowerCase().includes('grand final');

/**
 * From a phase's sets, pick the Top 8 bracket: the phaseGroup that contains the
 * Grand Final, returned whole so early Winners/Losers rounds (whose names
 * isTop8Round doesn't enumerate) are kept. A dedicated Top 8 phase is small; if
 * the group is unexpectedly large (a single-phase event that bundles the entire
 * bracket) keep only the canonical final rounds. Falls back to round-text
 * matching when no Grand Final is present yet.
 */
const TOP8_MAX_SETS = 16; // a full 8-player double-elim Top 8 is ~14 sets

function selectTop8Sets(phaseSets = []) {
  const byGroup = new Map();
  for (const s of phaseSets) {
    const key = s.phaseGroup?.id ?? 'none';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(s);
  }
  for (const [, sets] of byGroup) {
    if (sets.some((s) => isGrandFinal(s.fullRoundText))) {
      return sets.length <= TOP8_MAX_SETS ? sets : sets.filter((s) => isTop8Round(s.fullRoundText));
    }
  }
  return phaseSets.filter((s) => isTop8Round(s.fullRoundText));
}

async function findOrCreateGameId(videogame) {
  if (!videogame) return null;
  const existing = await db.getAsync('SELECT id FROM games WHERE startgg_id = ? OR name = ?', [videogame.id, videogame.name]);
  if (existing) return existing.id;
  const res = await db.runAsync('INSERT INTO games (name, startgg_id) VALUES (?, ?)', [videogame.name, videogame.id]);
  return res.lastID;
}

// A participant's uploaded start.gg profile photo, same `type: "profile"`
// convention already used for tournament/event logos elsewhere in this codebase.
// Optional per player — many entrants never upload one.
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

/**
 * Process one tournament's events (Start.gg shape). Exposed for testing with a
 * mocked payload. `tRow` is our tournaments row { id, ... }.
 */
async function processTournamentEvents(tRow, events = []) {
  const stats = { opened: 0, closed: 0, settled: 0, skipped: 0 };
  for (const ev of events) {
    const gameId = await findOrCreateGameId(ev.videogame);
    if (!gameId) continue;

    for (const set of selectTop8Sets(ev.sets?.nodes || [])) {
      const e0 = set.slots?.[0]?.entrant;
      const e1 = set.slots?.[1]?.entrant;
      const setId = String(set.id);
      const existing = await db.getAsync('SELECT id, state FROM set_markets WHERE startgg_set_id = ?', [setId]);

      if (set.state === 3 && set.winnerId != null) {
        if (!existing && e0?.id && e1?.id) {
          // Set completed before we ever saw it as upcoming (poller missed the window).
          // Create + settle it now so it appears in the bracket with the winner highlighted.
          const phaseGroupId = set.phaseGroup?.id != null ? String(set.phaseGroup.id) : null;
          const p0 = await findOrCreatePlayerId(e0);
          const p1 = await findOrCreatePlayerId(e1);
          if (p0 && p1) {
            await lm.fillBracketSlot({ tournamentId: tRow.id, gameId, startggSetId: setId, roundText: set.fullRoundText, roundInt: set.round ?? null, phaseGroupId, slot: 1, playerId: p0, seed: seedOf(e0) });
            await lm.fillBracketSlot({ tournamentId: tRow.id, gameId, startggSetId: setId, roundText: set.fullRoundText, roundInt: set.round ?? null, phaseGroupId, slot: 2, playerId: p1, seed: seedOf(e1) });
            const fresh = await db.getAsync('SELECT id, state FROM set_markets WHERE startgg_set_id = ?', [setId]);
            if (fresh && fresh.state !== 'settled') {
              const winnerEntrant = set.winnerId === e0.id ? e0 : e1;
              const winnerPid = await findOrCreatePlayerId(winnerEntrant);
              await lm.settleMarket(fresh.id, winnerPid, scoreOf(set.slots[0]), scoreOf(set.slots[1]));
              stats.settled++;
            }
          }
        } else if (existing && existing.state !== 'settled' && existing.state !== 'void' && e0?.id && e1?.id) {
          const winnerEntrant = set.winnerId === e0.id ? e0 : e1;
          const winnerPid = await findOrCreatePlayerId(winnerEntrant);
          await lm.settleMarket(existing.id, winnerPid, scoreOf(set.slots[0]), scoreOf(set.slots[1]));
          stats.settled++;
        }
        continue;
      }

      if (set.state === 2) {
        // Only treat a non-void market as "existing" — voided slots mean the
        // poller saw an incomplete set earlier and reset it; treat that the same
        // as "never seen" so we can create + close with the now-known players.
        const activeExisting = existing && existing.state !== 'void' ? existing : null;
        // Live scores from Start.gg — updated on every poll while the set is in progress.
        const p1s = scoreOf(set.slots[0]);
        const p2s = scoreOf(set.slots[1]);
        if (!activeExisting && e0?.id && e1?.id) {
          // Set went in-progress before we ever saw it fully populated (poller
          // missed the state-1 window). Create the market and immediately close
          // it so the match appears in the bracket with the LIVE badge.
          const phaseGroupId = set.phaseGroup?.id != null ? String(set.phaseGroup.id) : null;
          const p0 = await findOrCreatePlayerId(e0);
          const p1 = await findOrCreatePlayerId(e1);
          if (p0 && p1) {
            await lm.fillBracketSlot({ tournamentId: tRow.id, gameId, startggSetId: setId, roundText: set.fullRoundText, roundInt: set.round ?? null, phaseGroupId, slot: 1, playerId: p0, seed: seedOf(e0) });
            await lm.fillBracketSlot({ tournamentId: tRow.id, gameId, startggSetId: setId, roundText: set.fullRoundText, roundInt: set.round ?? null, phaseGroupId, slot: 2, playerId: p1, seed: seedOf(e1) });
            const fresh = await db.getAsync('SELECT id, state FROM set_markets WHERE startgg_set_id = ?', [setId]);
            if (fresh) await lm.closeMarket(fresh.id, p1s, p2s);
            stats.closed++;
          }
        } else if (activeExisting) {
          await lm.closeMarket(activeExisting.id, p1s, p2s);
          stats.closed++;
        }
        continue;
      }

      if (set.state === 1) {
        // Fill each known slot immediately; the market opens once both are real.
        // A set with one entrant (the other still TBD) becomes a pending node.
        const phaseGroupId = set.phaseGroup?.id != null ? String(set.phaseGroup.id) : null;
        let filled = 0;
        for (let i = 0; i < 2; i++) {
          const e = set.slots?.[i]?.entrant;
          if (!e?.id) continue;
          const pid = await findOrCreatePlayerId(e);
          if (!pid) continue;
          await lm.fillBracketSlot({
            tournamentId: tRow.id, gameId, startggSetId: setId, roundText: set.fullRoundText,
            roundInt: set.round ?? null, phaseGroupId,
            slot: i + 1, playerId: pid, seed: seedOf(e),
          });
          filled++;
        }
        if (!existing && filled > 0) stats.opened++;
      }
    }
  }
  return stats;
}

/**
 * Writes grouped round data (from groupSetsIntoRounds) into bracket_history —
 * one row per start.gg set, upserted by startgg_set_id. Read-only history:
 * never touches set_markets, odds, or bets. `tRow` is our tournaments row
 * ({ id, ... }); `gameId` is our games.id for this event's videogame.
 */
async function processHistorySets(tRow, gameId, roundGroups = []) {
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
      } else {
        await db.runAsync(
          `INSERT INTO bracket_history
             (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_order,
              state, player1_id, player2_id, winner_id, player1_score, player2_score)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [tRow.id, gameId, setId, group.roundText, group.roundInt, group.phaseOrder,
            state, p0, p1, winnerPid, p1Score, p2Score]
        );
      }
    }
  }
}

/**
 * Pull every set in one phase (paginated). The finals phase is small, but page
 * through it so a Top 8 with a deep losers bracket is never truncated.
 */
async function fetchPhaseSets(eventId, phaseId) {
  const all = [];
  for (let page = 1; page <= MAX_SET_PAGES; page++) {
    const data = await startgg(PHASE_SETS, { eventId, phaseId, page, perPage: SET_PAGE_SIZE });
    const conn = data?.event?.sets;
    const nodes = conn?.nodes || [];
    all.push(...nodes);
    if (nodes.length < SET_PAGE_SIZE || page >= (conn?.pageInfo?.totalPages ?? 1)) break;
  }
  return all;
}

/**
 * Same pagination as fetchPhaseSets, but with the lighter HISTORY_PHASE_SETS
 * query and a much smaller page size — early bracket rounds at huge events
 * (Evo-scale, hundreds of entrants) exceed Start.gg's query complexity cap at
 * the Top 8 path's page size, since history tracking here always requests
 * every non-final phase up front rather than one small finals phase.
 */
async function fetchHistoryPhaseSets(eventId, phaseId) {
  const all = [];
  for (let page = 1; page <= MAX_HISTORY_SET_PAGES; page++) {
    const data = await startgg(HISTORY_PHASE_SETS, { eventId, phaseId, page, perPage: HISTORY_SET_PAGE_SIZE });
    const conn = data?.event?.sets;
    const nodes = conn?.nodes || [];
    all.push(...nodes);
    if (nodes.length < HISTORY_SET_PAGE_SIZE || page >= (conn?.pageInfo?.totalPages ?? 1)) break;
  }
  return all;
}

/**
 * Resolve each event's FINAL phase (highest phaseOrder) and fetch its sets,
 * returning the { id, name, videogame, sets: { nodes } } shape that
 * processTournamentEvents consumes. Targeting the finals phase — instead of the
 * first page of the event-wide set list — is what makes Top 8 detection reliable
 * for large tournaments.
 */
async function fetchActiveEvents(startggId) {
  const data = await startgg(LIVE_PHASES, { id: startggId });
  const events = data?.tournament?.events || [];
  const out = [];
  for (const ev of events) {
    const phases = ev.phases || [];
    if (phases.length === 0) continue;
    const finalPhase = resolveFinalPhase(phases);
    const nodes = await fetchPhaseSets(ev.id, finalPhase.id);
    out.push({ id: ev.id, name: ev.name, videogame: ev.videogame, sets: { nodes } });
  }
  return out;
}

/**
 * Sets from every phase EXCEPT the final one (fetchActiveEvents already
 * covers the final/Top-8 phase for real markets). Read-only — feeds
 * bracket_history via processHistorySets, never set_markets. Returns one
 * entry per non-final phase so groupSetsIntoRounds can tell pools apart from
 * bracket rounds by phaseName.
 */
async function fetchHistoryPhases(startggId) {
  const data = await startgg(LIVE_PHASES, { id: startggId });
  const events = data?.tournament?.events || [];
  const out = [];
  for (const ev of events) {
    const phases = ev.phases || [];
    if (phases.length < 2) continue; // nothing before the final phase to track
    const finalPhase = resolveFinalPhase(phases);
    for (const phase of phases) {
      if (phase.id === finalPhase.id) continue;
      const nodes = await fetchHistoryPhaseSets(ev.id, phase.id);
      out.push({ eventId: ev.id, videogame: ev.videogame, phaseOrder: phase.phaseOrder ?? 0, phaseName: phase.name, sets: nodes });
    }
  }
  return out;
}

async function getActiveTournaments() {
  return db.allAsync(
    `SELECT id, name, startgg_id FROM tournaments
     WHERE startgg_id IS NOT NULL
       AND (is_live = 1 OR date(date) BETWEEN date('now','-1 day') AND date('now','+2 day'))`
  );
}

async function syncLive({ all = false } = {}) {
  const tournaments = all
    ? await db.allAsync('SELECT id, name, startgg_id FROM tournaments WHERE startgg_id IS NOT NULL')
    : await getActiveTournaments();
  if (tournaments.length === 0) return { tournaments: 0, opened: 0, closed: 0, settled: 0 };

  const totals = { tournaments: 0, opened: 0, closed: 0, settled: 0 };
  for (const tRow of tournaments) {
    try {
      const events = await fetchActiveEvents(tRow.startgg_id);
      const s = await processTournamentEvents(tRow, events);
      totals.tournaments++;
      totals.opened += s.opened; totals.closed += s.closed; totals.settled += s.settled;

      // Read-only round history for pre-Top-8 rounds — separate pass, separate
      // table, never touches set_markets/odds/bets.
      const historyPhases = await fetchHistoryPhases(tRow.startgg_id);
      const byGame = new Map();
      for (const phase of historyPhases) {
        const gameId = await findOrCreateGameId(phase.videogame);
        if (!gameId) continue;
        if (!byGame.has(gameId)) byGame.set(gameId, []);
        byGame.get(gameId).push(phase);
      }
      for (const [gameId, phases] of byGame) {
        await processHistorySets(tRow, gameId, groupSetsIntoRounds(phases));
      }
    } catch (err) {
      console.error(`[sync-live] ${tRow.name} (${tRow.startgg_id}) failed: ${err.message}`);
    }
  }
  // Auto-clear is_live for tournaments that have ended: date in the past and no
  // open or closed markets remain (everything is settled or void).
  await db.runAsync(`
    UPDATE tournaments
    SET is_live = 0
    WHERE is_live = 1
      AND date(date) < date('now')
      AND NOT EXISTS (
        SELECT 1 FROM set_markets sm
        WHERE sm.tournament_id = tournaments.id
          AND sm.state IN ('open', 'closed')
      )
  `);

  console.log(`[sync-live] ${totals.tournaments} tournament(s): +${totals.opened} open, ${totals.closed} closed, ${totals.settled} settled`);
  return totals;
}

module.exports = {
  syncLive, processTournamentEvents, fetchActiveEvents, selectTop8Sets, isTop8Round,
  isPoolsPhase, resolveFinalPhase, classifyRoundStatus, groupSetsIntoRounds, fetchHistoryPhases, processHistorySets,
};

if (require.main === module) {
  const all = process.argv.includes('--all');
  syncLive({ all }).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
}
