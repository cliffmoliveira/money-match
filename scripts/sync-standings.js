/**
 * Post-event final standings backfill (spec: "how far they made it" beyond
 * Top 8). For each already-tracked tournament, resolves each concluded
 * event's placements and upserts them into players_games_tournaments —
 * including for entrants who were never pre-seeded there, closing the gap
 * where a live Top-8 run with no pre-tournament seed row was invisible to
 * the Follow feature's tournament history.
 *
 * Capped at a placement depth (default 32): standings are paginated in
 * placement order, so a modest cap keeps this to ~1-2 API pages per event
 * instead of pulling every entrant down to last place.
 *
 * Usage:
 *   node scripts/sync-standings.js --dry-run       # report only, no writes
 *   node scripts/sync-standings.js                 # write placements
 *   node scripts/sync-standings.js --limit=5        # first 5 tournaments only
 *   node scripts/sync-standings.js --cap=64         # override placement depth
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
const CAP = (() => {
  const a = process.argv.find((x) => x.startsWith('--cap='));
  return a ? parseInt(a.split('=')[1], 10) : 32;
})();

const STANDINGS_PAGE_SIZE = 32; // >= CAP by default so most events finish in one page
const MAX_STANDINGS_PAGES = 8;

const TOURNAMENT_EVENTS = `
  query TournamentEvents($id: ID!) {
    tournament(id: $id) {
      id name
      events { id name state videogame { id name } }
    }
  }`;

// Standings come back ordered by placement ascending.
const EVENT_STANDINGS = `
  query EventStandings($eventId: ID!, $page: Int!, $perPage: Int!) {
    event(id: $eventId) {
      standings(query: { page: $page, perPage: $perPage }) {
        pageInfo { totalPages }
        nodes {
          placement
          entrant { id name participants { images { type url } player { id } } }
        }
      }
    }
  }`;

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

// Concluded events only — standings aren't final otherwise. Event.state comes
// back as the string "COMPLETED" (unlike Set.state, which is numeric).
async function fetchCompletedEvents(startggId) {
  const data = await ggRetry(TOURNAMENT_EVENTS, { id: startggId });
  const events = data?.tournament?.events || [];
  return events.filter((ev) => ev.state === 'COMPLETED' && ev.videogame?.id);
}

// Page through standings up to CAP, stopping early once placements exceed it.
async function fetchStandings(eventId, cap) {
  const all = [];
  for (let page = 1; page <= MAX_STANDINGS_PAGES; page++) {
    const data = await ggRetry(EVENT_STANDINGS, { eventId, page, perPage: STANDINGS_PAGE_SIZE });
    const nodes = data?.event?.standings?.nodes || [];
    for (const n of nodes) {
      if (n.placement != null && n.placement <= cap) all.push(n);
    }
    const totalPages = data?.event?.standings?.pageInfo?.totalPages || 1;
    const lastPlacement = nodes[nodes.length - 1]?.placement;
    if (nodes.length < STANDINGS_PAGE_SIZE || page >= totalPages) break;
    if (lastPlacement != null && lastPlacement >= cap) break;
  }
  return all;
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

// Creates the tournament/game/player row if it doesn't exist yet (fixes the
// pre-seed-only visibility gap), or just updates placement if it does. A
// finalized placement is authoritative — no is_winner-style guard needed,
// unlike the seed/odds upsert in sync-upcoming.js which must avoid clobbering
// live betting data.
async function upsertPlacement(tournamentId, gameId, playerId, placement) {
  await db.runAsync(
    `INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, placement, created_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(tournament_id, game_id, player_id) DO UPDATE SET placement = excluded.placement`,
    [tournamentId, gameId, playerId, placement]
  );
}

async function main() {
  const tournaments = await db.allAsync(
    `SELECT id, name, startgg_id FROM tournaments
     WHERE startgg_id IS NOT NULL AND date(date) < date('now')
     ORDER BY date DESC`
  );
  const list = LIMIT ? tournaments.slice(0, LIMIT) : tournaments;
  console.log(`${DRY ? '[DRY-RUN] ' : ''}Syncing standings (cap=${CAP}) for ${list.length} past tournament(s)…`);

  let written = 0, eventsSeen = 0, errors = 0;
  for (const t of list) {
    try {
      const events = await fetchCompletedEvents(t.startgg_id);
      for (const ev of events) {
        eventsSeen++;
        const standings = await fetchStandings(ev.id, CAP);
        if (!standings.length) { console.log(`  · ${t.name} / ${ev.name}: no standings`); continue; }
        const gameId = DRY ? -1 : await findOrCreateGameId(ev.videogame);
        if (!DRY) {
          for (const node of standings) {
            const playerId = await findOrCreatePlayerId(node.entrant);
            await upsertPlacement(t.id, gameId, playerId, node.placement);
            written++;
          }
        } else {
          written += standings.length;
        }
        console.log(`  ✓ ${t.name} / ${ev.name} (${ev.videogame.name}): ${standings.length} placement(s) <= ${CAP}`);
      }
    } catch (err) {
      errors++;
      console.error(`  ✗ ${t.name} (sgg:${t.startgg_id}): ${err.message}`);
    }
  }
  console.log(`\nDone. events=${eventsSeen} placements_written=${written} errors=${errors}`);
  process.exit(0);
}

main();
