/**
 * One-shot historical Top 8 backfill for 2026 past events.
 *
 * Pulls each past 2026 tournament's final-phase sets from Start.gg and writes the
 * completed Top 8 sets as state='settled' rows in set_markets, so the Tournaments
 * page renders real past brackets. Self-contained (does NOT import the live
 * poller) and idempotent (INSERT OR IGNORE on the unique startgg_set_id).
 *
 * Usage:
 *   node scripts/backfill-top8-2026.js --dry-run     # report only, no writes
 *   node scripts/backfill-top8-2026.js               # write settled markets
 *   node scripts/backfill-top8-2026.js --limit=5     # first 5 tournaments only
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

const SET_PAGE_SIZE = 50;
const MAX_SET_PAGES = 6;
const TOP8_MAX_SETS = 16;

// Mirrors sync-live.js LIVE_PHASES.
const LIVE_PHASES = `
  query Phases($id: ID!) {
    tournament(id: $id) {
      events { id name videogame { id name } phases { id phaseOrder } }
    }
  }`;

// Mirrors sync-live.js PHASE_SETS.
const PHASE_SETS = `
  query PhaseSets($eventId: ID!, $phaseId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      sets(page: $page, perPage: $perPage, filters: { phaseIds: [$phaseId] }) {
        pageInfo { totalPages }
        nodes {
          id state fullRoundText round winnerId
          phaseGroup { id }
          slots {
            entrant { id name seeds { seedNum } participants { images { type url } player { id } } }
            standing { stats { score { value } } }
          }
        }
      }
    }
  }`;

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
const isGrandFinal = (t) => /grand final/.test(norm(t));
const TOP8_ROUNDS = [/grand final/, /winners final/, /winners semi final/, /losers final/, /losers semi final/, /losers quarter final/];
const isTop8Round = (t) => { const n = norm(t); return TOP8_ROUNDS.some((re) => re.test(n)); };

const seedOf = (e) => e?.seeds?.[0]?.seedNum ?? null;
const scoreOf = (slot) => { const v = slot?.standing?.stats?.score?.value; return v != null && v >= 0 ? v : 0; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ_DELAY_MS = 800; // proactive pacing — Start.gg caps at ~80 requests/minute
const MAX_RETRIES = 6;

// Throttled Start.gg call: paces every request and backs off on HTTP 429 so a bulk
// historical load doesn't trip the rate limiter (which the live poller never hits).
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

// Resolve each event's final phase (highest phaseOrder) and fetch its sets.
async function fetchEvents(startggId) {
  const data = await ggRetry(LIVE_PHASES, { id: startggId });
  const events = data?.tournament?.events || [];
  const out = [];
  for (const ev of events) {
    const phases = ev.phases || [];
    if (!phases.length) continue;
    const finalPhase = phases.reduce((a, b) => (b.phaseOrder > a.phaseOrder ? b : a));
    const nodes = await fetchPhaseSets(ev.id, finalPhase.id);
    out.push({ id: ev.id, name: ev.name, videogame: ev.videogame, sets: nodes });
  }
  return out;
}

// Pick the Top 8 sets (mirrors sync-live.js selectTop8Sets).
function selectTop8Sets(phaseSets) {
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

async function findOrCreateGameId(vg) {
  const existing = await db.getAsync('SELECT id FROM games WHERE startgg_id = ? OR name = ?', [vg.id, vg.name]);
  if (existing) return existing.id;
  const res = await db.runAsync('INSERT INTO games (name, startgg_id) VALUES (?, ?)', [vg.name, vg.id]);
  return res.lastID;
}

// findOrCreatePlayerId lives in ./lib/players — shared with every other
// ingestion script (see that module's doc comment for why: Entrant.id isn't
// a stable per-person identifier, Participant.player.id is).

// Write one completed set as a settled market. Idempotent on startgg_set_id.
async function insertSettledMarket({ tournamentId, gameId, set }) {
  const e0 = set.slots?.[0]?.entrant, e1 = set.slots?.[1]?.entrant;
  if (!e0?.id || !e1?.id || set.winnerId == null) return { skipped: true };
  const setId = `hist-${set.id}`;
  const existing = await db.getAsync('SELECT id FROM set_markets WHERE startgg_set_id = ?', [setId]);
  if (existing) return { existed: true };

  const p1 = await findOrCreatePlayerId(e0);
  const p2 = await findOrCreatePlayerId(e1);
  const winnerPid = set.winnerId === e0.id ? p1 : (set.winnerId === e1.id ? p2 : null);
  if (winnerPid == null) return { skipped: true };

  await db.runAsync(
    `INSERT INTO set_markets
       (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_group_id,
        player1_id, player2_id, p1_seed, p2_seed, state,
        p1_prob, p2_prob, seed_k_cents, p1_pool_cents, p2_pool_cents,
        p1_live_odds, p2_live_odds, winner_id, p1_score, p2_score, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', 0.5, 0.5, 0, 0, 0, 0, 0, ?, ?, ?, datetime('now'))
     ON CONFLICT(startgg_set_id) DO NOTHING`,
    [tournamentId, gameId, setId, set.fullRoundText || null, set.round ?? null,
     set.phaseGroup?.id ?? null, p1, p2, seedOf(e0), seedOf(e1),
     winnerPid, scoreOf(set.slots[0]), scoreOf(set.slots[1])]
  );
  return { created: true };
}

async function main() {
  const tournaments = await db.allAsync(
    `SELECT id, name, startgg_id, date FROM tournaments
     WHERE strftime('%Y', date) = '2026' AND date(date) < date('now') AND startgg_id IS NOT NULL
     ORDER BY date DESC`
  );
  const list = LIMIT ? tournaments.slice(0, LIMIT) : tournaments;
  console.log(`${DRY ? '[DRY-RUN] ' : ''}Backfilling Top 8 for ${list.length} past 2026 tournaments…`);

  let created = 0, existed = 0, skipped = 0, eventsSeen = 0, errors = 0;
  for (const t of list) {
    try {
      const events = await fetchEvents(t.startgg_id);
      for (const ev of events) {
        eventsSeen++;
        if (!ev.videogame?.id) continue;
        const top8 = selectTop8Sets(ev.sets).filter((s) => s.state === 3 && s.winnerId != null);
        if (!top8.length) { console.log(`  · ${t.name} / ${ev.name}: no completed Top 8 sets`); continue; }
        const gameId = DRY ? -1 : await findOrCreateGameId(ev.videogame);
        for (const set of top8) {
          if (DRY) { created++; continue; }
          const r = await insertSettledMarket({ tournamentId: t.id, gameId, set });
          if (r.created) created++; else if (r.existed) existed++; else skipped++;
        }
        console.log(`  ✓ ${t.name} / ${ev.name} (${ev.videogame.name}): ${top8.length} sets`);
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ ${t.name} (sgg:${t.startgg_id}): ${err.message}`);
    }
  }
  console.log(`\nDone. events=${eventsSeen} created=${created} existed=${existed} skipped=${skipped} errors=${errors}`);
  process.exit(0);
}

main();
