/**
 * Backfill Past Results from start.gg.
 *
 * For every fighting-game tournament on start.gg in a date range, records the
 * Grand Finals result (1st place beats 2nd place) per game into the matches
 * table, which feeds the Past Results page.
 *
 * Usage:
 *   node scripts/backfill-results.js [options]
 *
 * Options:
 *   --start YYYY-MM-DD      Range start (default 2025-01-01)
 *   --end YYYY-MM-DD        Range end (default today)
 *   --min-entrants N        Skip events with fewer entrants (default 16)
 *   --min-attendees N       Skip tournaments with fewer attendees (default 0)
 *   --dry-run               Log what would be written, touch nothing
 *   --reset                 Ignore saved progress and start over
 *
 * Progress is checkpointed to scripts/.backfill-state.json after every
 * tournament, so the script is safe to interrupt and re-run.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const db = require('../db/db');
const { startgg } = require('../startggClient');
const { findOrCreatePlayerId } = require('./lib/players');

const STATE_FILE = path.join(__dirname, '.backfill-state.json');

// Major fighting games to backfill. IDs are resolved against the start.gg
// API on first run and cached in the state file.
const GAME_NAMES = [
  'Street Fighter 6',
  'Tekken 8',
  'Guilty Gear -Strive-',
  'Mortal Kombat 1',
  'Super Smash Bros. Ultimate',
  'Super Smash Bros. Melee',
  'The King of Fighters XV',
  'Dragon Ball FighterZ',
  'Granblue Fantasy Versus: Rising',
  'Fatal Fury: City of the Wolves',
];

// start.gg allows 80 requests/minute; stay well under it.
const REQUEST_GAP_MS = 900;
const WEEK_SEC = 7 * 24 * 60 * 60;

const GQL_VIDEOGAME_LOOKUP = `
query Lookup($name: String) {
  videogames(query: { filter: { name: $name }, perPage: 5 }) {
    nodes { id name }
  }
}`;

const GQL_TOURNAMENTS_RANGE = `
query TournamentsRange($page: Int!, $perPage: Int!, $after: Timestamp, $before: Timestamp, $videogameIds: [ID]) {
  tournaments(query: {
    page: $page, perPage: $perPage, sortBy: "startAt asc",
    filter: { afterDate: $after, beforeDate: $before, past: true, videogameIds: $videogameIds }
  }) {
    pageInfo { totalPages }
    nodes { id name slug city countryCode startAt numAttendees }
  }
}`;

const GQL_TOURNAMENT_RESULTS = `
query TournamentResults($slug: String!, $videogameIds: [ID]) {
  tournament(slug: $slug) {
    id name city countryCode startAt
    images { type url }
    events(limit: 40, filter: { videogameId: $videogameIds }) {
      id name numEntrants state
      videogame { id name }
      standings(query: { perPage: 2, page: 1 }) {
        nodes { placement entrant { id name participants { images { type url } player { id } } } }
      }
    }
  }
}`;

// Fetched separately (and best-effort) to get the Grand Finals score.
const GQL_EVENT_GF_SETS = `
query EventSets($eventId: ID!) {
  event(id: $eventId) {
    sets(perPage: 10, page: 1, sortType: RECENT, filters: { state: 3 }) {
      nodes {
        id fullRoundText completedAt winnerId
        slots { entrant { id name } standing { stats { score { value } } } }
      }
    }
  }
}`;

function parseArgs(argv) {
  const args = { start: '2025-01-01', end: null, minEntrants: 16, minAttendees: 0, dryRun: false, reset: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--start': args.start = argv[++i]; break;
      case '--end': args.end = argv[++i]; break;
      case '--min-entrants': args.minEntrants = Number(argv[++i]); break;
      case '--min-attendees': args.minAttendees = Number(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
      case '--reset': args.reset = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function loadState(reset) {
  if (!reset && fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return { gameIds: {}, doneChunks: {}, doneTournaments: {} };
}

let stateWritesEnabled = true;

function saveState(state) {
  if (!stateWritesEnabled) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Throttled start.gg call with retry on rate-limit/transient errors.
async function gql(query, variables) {
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await startgg(query, variables);
      await sleep(REQUEST_GAP_MS);
      return data;
    } catch (err) {
      const status = err.response?.status;
      // Retry rate limits, any 5xx (including Cloudflare 52x), and network drops.
      const retryable = status === 429 || (status >= 500 && status < 600) || (!err.response && !!err.request);
      if (!retryable || attempt >= 5) throw err;
      const backoff = Math.min(60000, 2000 * 2 ** attempt);
      console.warn(`  start.gg ${status}; retrying in ${backoff / 1000}s (attempt ${attempt}/5)`);
      await sleep(backoff);
    }
  }
}

async function resolveGameIds(state) {
  for (const name of GAME_NAMES) {
    if (state.gameIds[name]) continue;
    const data = await gql(GQL_VIDEOGAME_LOOKUP, { name });
    const nodes = data?.videogames?.nodes || [];
    const exact = nodes.find((n) => n.name.toLowerCase() === name.toLowerCase()) || nodes[0];
    if (!exact) {
      console.warn(`Could not resolve videogame id for "${name}"; skipping it.`);
      continue;
    }
    state.gameIds[name] = exact.id;
    console.log(`Resolved "${name}" -> videogame id ${exact.id}`);
  }
  saveState(state);
  const ids = Object.values(state.gameIds);
  if (ids.length === 0) throw new Error('No videogame ids resolved; cannot continue.');
  return new Set(ids.map(Number));
}

async function upsertTournament(t) {
  // Full timestamp for the DB column — start.gg's startAt carries the real
  // start hour, not just the calendar date. Keep a plain date-only string
  // around too, purely for the human-readable name-disambiguation suffix.
  const date = new Date(t.startAt * 1000).toISOString();
  const dateOnly = date.slice(0, 10);
  // "profile" is the square logo; fall back to the banner if there isn't one.
  const images = t.images || [];
  const logoUrl = images.find((i) => i.type === 'profile')?.url
    || images.find((i) => i.type === 'banner')?.url
    || null;
  const existing = await db.getAsync('SELECT id FROM tournaments WHERE startgg_id = ?', [t.id]);
  // tournaments.name is UNIQUE; if a *different* tournament already holds this
  // name (start.gg allows duplicates), disambiguate with the date.
  const nameTaken = await db.getAsync(
    'SELECT id FROM tournaments WHERE name = ? AND id != ?',
    [t.name, existing?.id ?? -1]
  );
  const name = nameTaken ? `${t.name} (${dateOnly})` : t.name;
  if (existing) {
    await db.runAsync(
      'UPDATE tournaments SET name = ?, date = ?, city = ?, country = ?, logo_url = ? WHERE id = ?',
      [name, date, t.city || '', t.countryCode || '', logoUrl, existing.id]
    );
    return existing.id;
  }
  const result = await db.runAsync(
    'INSERT INTO tournaments (name, date, city, country, startgg_id, logo_url) VALUES (?, ?, ?, ?, ?, ?)',
    [name, date, t.city || '', t.countryCode || '', t.id, logoUrl]
  );
  return result.lastID;
}

async function upsertGame(g) {
  const existing = await db.getAsync('SELECT id FROM games WHERE startgg_id = ? OR name = ?', [g.id, g.name]);
  if (existing) {
    await db.runAsync('UPDATE games SET startgg_id = COALESCE(startgg_id, ?) WHERE id = ?', [g.id, existing.id]);
    return existing.id;
  }
  const result = await db.runAsync('INSERT INTO games (name, startgg_id) VALUES (?, ?)', [g.name, g.id]);
  return result.lastID;
}

// findOrCreatePlayerId lives in ./lib/players — shared with every other
// ingestion script (see that module's doc comment for why: Entrant.id isn't
// a stable per-person identifier, Participant.player.id is).

// Best-effort: find the deciding Grand Finals set for a score. Standings
// already give us winner/loser, so failures here just mean a 0-0 score.
async function fetchGrandFinalsScore(eventId, winnerEntrantId) {
  try {
    const data = await gql(GQL_EVENT_GF_SETS, { eventId });
    const sets = data?.event?.sets?.nodes || [];
    const gf = sets
      .filter((s) => (s.fullRoundText || '').toLowerCase().includes('grand final'))
      .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))[0];
    if (!gf || gf.winnerId !== winnerEntrantId) return null;
    const score = (slot) => {
      const v = slot?.standing?.stats?.score?.value;
      return typeof v === 'number' && v >= 0 ? v : 0;
    };
    const [s0, s1] = gf.slots || [];
    const winnerFirst = s0?.entrant?.id === winnerEntrantId;
    return {
      winnerScore: score(winnerFirst ? s0 : s1),
      loserScore: score(winnerFirst ? s1 : s0),
    };
  } catch (err) {
    return null;
  }
}

async function recordResult(tournamentDbId, event, winner, runnerUp, dryRun) {
  // Negative event id as the match's startgg_id keeps standings-derived rows
  // from colliding with set ids written by syncStartgg.js.
  const matchKey = -Math.abs(Number(event.id));

  if (dryRun) {
    console.log(`  [dry-run] ${event.videogame.name}: ${winner.entrant.name} def. ${runnerUp.entrant.name}`);
    return true;
  }

  const gameDbId = await upsertGame(event.videogame);
  const winnerDbId = await findOrCreatePlayerId(winner.entrant);
  const loserDbId = await findOrCreatePlayerId(runnerUp.entrant);
  if (!winnerDbId || !loserDbId) return false;

  const score = await fetchGrandFinalsScore(event.id, winner.entrant.id);
  const winnerScore = score?.winnerScore ?? 0;
  const loserScore = score?.loserScore ?? 0;

  const existing = await db.getAsync('SELECT id FROM matches WHERE startgg_id = ?', [matchKey]);
  if (existing) {
    await db.runAsync(
      `UPDATE matches SET tournament_id=?, game_id=?, player1_id=?, player2_id=?, winner_id=?, loser_id=?,
       player1RoundsWon=?, player2RoundsWon=? WHERE id=?`,
      [tournamentDbId, gameDbId, winnerDbId, loserDbId, winnerDbId, loserDbId, winnerScore, loserScore, existing.id]
    );
  } else {
    await db.runAsync(
      `INSERT INTO matches (tournament_id, game_id, player1_id, player2_id, winner_id, loser_id,
       player1RoundsWon, player2RoundsWon, startgg_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tournamentDbId, gameDbId, winnerDbId, loserDbId, winnerDbId, loserDbId, winnerScore, loserScore, matchKey]
    );
  }
  console.log(`  ${event.videogame.name}: ${winner.entrant.name} def. ${runnerUp.entrant.name} (${winnerScore}-${loserScore})`);
  return true;
}

async function processTournament(slug, gameIdSet, args) {
  const data = await gql(GQL_TOURNAMENT_RESULTS, { slug, videogameIds: [...gameIdSet] });
  const t = data?.tournament;
  if (!t) return 0;

  // state 3 = completed; only events for the games we track, big enough to matter.
  const eligible = (t.events || []).filter((ev) =>
    ev.videogame && gameIdSet.has(Number(ev.videogame.id)) &&
    (ev.numEntrants || 0) >= args.minEntrants
  );

  // Keep one event per game: the largest bracket is the main singles event;
  // the rest are side brackets (doubles, squad strike, amateur, etc.).
  const mainEventByGame = new Map();
  for (const ev of eligible) {
    const key = Number(ev.videogame.id);
    const current = mainEventByGame.get(key);
    if (!current || (ev.numEntrants || 0) > (current.numEntrants || 0)) {
      mainEventByGame.set(key, ev);
    }
  }
  const events = [...mainEventByGame.values()];

  let recorded = 0;
  let tournamentDbId = null;
  for (const ev of events) {
    const standings = ev.standings?.nodes || [];
    const winner = standings.find((s) => s.placement === 1);
    const runnerUp = standings.find((s) => s.placement === 2);
    if (!winner?.entrant || !runnerUp?.entrant) continue;

    if (tournamentDbId === null && !args.dryRun) {
      tournamentDbId = await upsertTournament(t);
    }
    if (await recordResult(tournamentDbId, ev, winner, runnerUp, args.dryRun)) recorded++;
  }
  return recorded;
}

async function main() {
  const args = parseArgs(process.argv);
  // Dry runs must not checkpoint progress, or a later real run would skip
  // everything the dry run looked at.
  if (args.dryRun) stateWritesEnabled = false;
  const state = loadState(args.reset);

  const startSec = Math.floor(new Date(`${args.start}T00:00:00Z`).getTime() / 1000);
  const endSec = args.end
    ? Math.floor(new Date(`${args.end}T23:59:59Z`).getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    throw new Error('Invalid --start/--end date');
  }

  console.log(`Backfilling ${args.start} -> ${args.end || 'today'} (min entrants: ${args.minEntrants}, min attendees: ${args.minAttendees})${args.dryRun ? ' [DRY RUN]' : ''}`);

  const gameIdSet = await resolveGameIds(state);
  let totalMatches = 0;
  let totalTournaments = 0;

  for (let chunkStart = startSec; chunkStart < endSec; chunkStart += WEEK_SEC) {
    const chunkEnd = Math.min(chunkStart + WEEK_SEC, endSec);
    const chunkLabel = new Date(chunkStart * 1000).toISOString().slice(0, 10);
    if (state.doneChunks[chunkLabel]) continue;

    console.log(`\n=== Week of ${chunkLabel} ===`);
    let page = 1;
    while (true) {
      const data = await gql(GQL_TOURNAMENTS_RANGE, {
        page, perPage: 50, after: chunkStart, before: chunkEnd,
        videogameIds: [...gameIdSet],
      });
      const nodes = data?.tournaments?.nodes || [];
      const totalPages = data?.tournaments?.pageInfo?.totalPages || page;
      if (nodes.length === 0) break;

      for (const t of nodes) {
        if (!t.slug || state.doneTournaments[t.slug]) continue;
        if ((t.numAttendees || 0) < args.minAttendees) {
          state.doneTournaments[t.slug] = true;
          continue;
        }
        try {
          const recorded = await processTournament(t.slug, gameIdSet, args);
          if (recorded > 0) {
            totalMatches += recorded;
            totalTournaments++;
            console.log(`${t.name} [${t.slug}]: ${recorded} result(s)`);
          }
          state.doneTournaments[t.slug] = true;
          saveState(state);
        } catch (err) {
          // A single oversized/broken tournament shouldn't kill the run.
          if (/complexity/i.test(err.message)) {
            console.warn(`Skipping ${t.slug}: query too complex even with filters.`);
            state.doneTournaments[t.slug] = true;
            saveState(state);
            continue;
          }
          console.error(`Failed on ${t.slug}: ${err.message} — will retry on next run.`);
          saveState(state);
          throw err;
        }
      }

      if (page >= totalPages) break;
      page++;
    }

    state.doneChunks[chunkLabel] = true;
    saveState(state);
  }

  console.log(`\nDone. Recorded ${totalMatches} results across ${totalTournaments} tournaments.`);
  process.exit(0);
}

// Run the full historical backfill only when invoked directly; when required
// as a module (e.g. by the daily auto-sync) just expose the reusable pieces.
if (require.main === module) {
  main().catch((err) => {
    console.error(`\nBackfill stopped: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { processTournament };
