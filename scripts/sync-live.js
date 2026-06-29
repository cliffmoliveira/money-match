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
      phases { id phaseOrder }
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
          entrant { id name seeds { seedNum } }
          standing { stats { score { value } } }
        }
      }
    }
  }
}`;

const SET_PAGE_SIZE = 50;
const MAX_SET_PAGES = 6; // a Top 8 phase is small; cap to bound a pathological event

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

async function findOrCreatePlayerId(entrant) {
  const name = entrant?.name?.trim();
  if (!name) return null;
  const existing = await db.getAsync('SELECT id FROM players WHERE startgg_id = ? OR name = ?', [entrant.id, name]);
  if (existing) {
    await db.runAsync('UPDATE players SET startgg_id = COALESCE(startgg_id, ?) WHERE id = ?', [entrant.id, existing.id]);
    return existing.id;
  }
  const res = await db.runAsync('INSERT INTO players (name, country, startgg_id) VALUES (?, ?, ?)', [name, '', entrant.id]);
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
    const finalPhase = phases.reduce((a, b) => ((b.phaseOrder ?? 0) > (a.phaseOrder ?? 0) ? b : a));
    const nodes = await fetchPhaseSets(ev.id, finalPhase.id);
    out.push({ id: ev.id, name: ev.name, videogame: ev.videogame, sets: { nodes } });
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

module.exports = { syncLive, processTournamentEvents, fetchActiveEvents, selectTop8Sets, isTop8Round };

if (require.main === module) {
  const all = process.argv.includes('--all');
  syncLive({ all }).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
}
