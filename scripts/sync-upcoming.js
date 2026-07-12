/**
 * Populate the Future Tournaments page with upcoming MAJOR fighting-game
 * tournaments from start.gg and their top-seeded entrants (so there's
 * something to bet on).
 *
 * Unlike past results, upcoming events can't be filtered by attendance
 * (registration fills up close to the date), so we curate by known major
 * brands and pull every upcoming edition of each.
 *
 * For each matching tournament it upserts the tournament (+ logo), each event
 * for a tracked game, and the top N seeds as players_games_tournaments rows
 * with a starting live_odds of 1.0.
 *
 * Usage:
 *   node scripts/sync-upcoming.js [--months N] [--top N] [--dry-run]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/db');
const { startgg } = require('../startggClient');
const { fieldProbabilities } = require('../liveOdds');
const { applyFuturesMetaSchema, upsertEntrantCount, upsertTournamentGame } = require('../futuresMeta');
const { findOrCreatePlayerId } = require('./lib/players');

const FIELD_PLAYER_NAME = 'The Field';
// Futures open only within this many days of the event (seeding is finalized
// close to the event) and only when the top seed is genuinely low.
const FUTURES_WINDOW_DAYS = 21;
const SEED_SANITY_MAX = 4;
// start.gg's `upcoming: true` filter drops a tournament the moment it starts
// - and a tournament that's currently mid-bracket is neither `upcoming: true`
// nor `past: true` (confirmed against the live API: a same-day event in
// progress is invisible to both booleans). One that only becomes seed-
// eligible (real seeds, within FUTURES_WINDOW_DAYS) between two daily runs
// can therefore go live without ever being seeded, leaving its Outright picks
// stuck on "not available" forever. So also sweep a plain date-range window
// around "now" (no upcoming/past filter at all) each run, to catch anything
// straddling that boundary. Seed data doesn't change once the bracket begins,
// so backfilling it after the fact is exactly as accurate as catching it the
// day before.
const NEAR_NOW_WINDOW_DAYS = 2;
// Reuse the backfill's main-event Grand Finals recorder for the recent-results sync.
const { processTournament: recordPastResults } = require('./backfill-results');

// Tracked fighting games (start.gg videogame ids). Original backfill set + the
// remaining Evo 2026 games (2XKO, BlazBlue CF, Invincible Vs., Vampire Savior,
// Rivals II, UNI2, VF5) so their futures populate.
const GAME_IDS = [43868, 49783, 33945, 48599, 1386, 1, 36963, 287, 48548, 73221,
  64423, 37, 108058, 582, 53945, 50203, 114237];

// Curated major brands: { search } is the start.gg name query; { re } must
// match the tournament name to qualify. Anchored at the start (after an
// optional "The ") with a word boundary so "Evo 2026" matches but local hype
// events like "Pre-Evo Warmup" or "Evolution Crash Course" don't.
const BRANDS = [
  { search: 'Evo',                     re: /^evo\b/i },
  // Require a year so the flagship "CEO 2026" matches but "CEO: <subtitle>"
  // online series don't. (CEOtaku has its own entry below.)
  { search: 'CEO',                     re: /^ceo\s+\d{4}\b/i },
  { search: 'Combo Breaker',           re: /^combo\s+breaker\b/i },
  { search: 'Frosty Faustings',        re: /^frosty\s+faustings\b/i },
  { search: 'DreamHack',               re: /^dreamhack\b/i },
  { search: 'Red Bull Kumite',         re: /^red\s+bull\s+kumite\b/i },
  { search: 'Capcom Cup',              re: /^capcom\s+cup\b/i },
  { search: 'CEOtaku',                 re: /^ceotaku\b/i },
  { search: 'The Mixup',               re: /^mixup\b/i },
  { search: 'VSFighting',              re: /^vs\s*fighting\b/i },
  { search: 'East Coast Throwdown',    re: /^east\s+coast\s+throwdown\b/i },
  { search: 'Texas Showdown',          re: /^texas\s+showdown\b/i },
  // Require a number/roman-numeral/X after "Genesis" to match the Smash major
  // (Genesis X, Genesis 9) and exclude the "Genesis Cup" online Tekken series.
  // "x\d*\b" (not "x\b"): the real listing titles are "Genesis X2"/"Genesis
  // X3" — X directly followed by the edition number, no space — which a
  // bare "x\b" never matches (no word boundary between "X" and "2"). Found
  // by the regression suite in test/sync/brands.test.js: both editions are
  // already in our DB with real startgg_ids from a past broad backfill, but
  // the CURRENT regex couldn't have discovered either one via the daily
  // sync — same silent-miss shape as the Battle Arena Melbourne bug.
  { search: 'Genesis',                 re: /^genesis\s+(x\d*\b|\d|[ivxlcdm]+\b)/i },
  { search: 'Super Smash Con',         re: /^super\s+smash\s+con\b/i },
  // NOT ^-anchored (unlike its siblings above): the organizers' own start.gg
  // listing is titled "BAM <N>: Battle Arena Melbourne <N>" (confirmed for
  // BAM 14/15/16), so an anchored match silently rejected every edition —
  // start.gg's own name search found it fine, but our own re-filter then
  // discarded it. "World Warrior"/"Esports World Cup" below already use this
  // same anywhere-in-name shape for the identical reason (varying prefixes).
  { search: 'Battle Arena Melbourne',  re: /battle\s+arena\s+melbourne\b/i },
  { search: 'Tekken World Tour',       re: /^tekken\s+world\s+tour\b/i },
  { search: 'Ultimate Fighting Arena', re: /^ultimate\s+fighting\s+arena\b/i },
  // Street Fighter 6 Capcom Pro Tour 2026 qualifiers. "World Warrior" is a
  // distinctive phrase, so match it anywhere in the name (region/edition vary:
  // "World Warrior 2026 - US-Canada East #3", etc.); paginated below since there
  // are ~90 globally. Esports World Cup is a Premier major.
  { search: 'World Warrior',           re: /world\s+warrior/i },
  { search: 'Esports World Cup',       re: /esports\s+world\s+cup/i },
];

// Strip a leading "The " so "The Mixup 2026" matches /^mixup\b/.
const normalizeName = (name) => name.trim().replace(/^the\s+/i, '');

const REQUEST_GAP_MS = 900;

function parseArgs(argv) {
  const args = { months: 12, top: 8, dryRun: false, results: false, days: 30 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--months') args.months = Number(argv[++i]);
    else if (argv[i] === '--top') args.top = Number(argv[++i]);
    else if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--results') args.results = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables) {
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await startgg(query, variables);
      await sleep(REQUEST_GAP_MS);
      return data;
    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || (!err.response && !!err.request);
      if (!retryable || attempt >= 5) throw err;
      const backoff = Math.min(60000, 2000 * 2 ** attempt);
      console.warn(`  start.gg ${status || 'network'}; retry in ${backoff / 1000}s (${attempt}/5)`);
      await sleep(backoff);
    }
  }
}

const BRAND_SEARCH = `
query UpcomingBrand($name: String!, $after: Timestamp!, $before: Timestamp!, $ids: [ID], $page: Int!) {
  tournaments(query: { perPage: 25, page: $page, sortBy: "startAt asc",
    filter: { name: $name, upcoming: true, afterDate: $after, beforeDate: $before, videogameIds: $ids } }) {
    nodes { id name slug startAt city countryCode images { type url } }
  }
}`;

// No upcoming/past filter at all - start.gg treats "currently in progress" as
// neither, so a plain date-range sweep is the only way to catch a tournament
// that's live right now.
const NEAR_NOW_BRAND_SEARCH = `
query NearNowBrand($name: String!, $after: Timestamp!, $before: Timestamp!, $ids: [ID], $page: Int!) {
  tournaments(query: { perPage: 25, page: $page, sortBy: "startAt asc",
    filter: { name: $name, afterDate: $after, beforeDate: $before, videogameIds: $ids } }) {
    nodes { id name slug startAt city countryCode images { type url } }
  }
}`;

const PAST_BRAND_SEARCH = `
query RecentBrand($name: String!, $after: Timestamp!, $before: Timestamp!, $ids: [ID], $page: Int!) {
  tournaments(query: { perPage: 25, page: $page, sortBy: "startAt desc",
    filter: { name: $name, past: true, afterDate: $after, beforeDate: $before, videogameIds: $ids } }) {
    nodes { slug name }
  }
}`;

// Pull the entry phase's SEEDS (seed-ordered) rather than the unsorted entrant
// list — that's the only way to reliably get the actual top seeds (#1, #2 …).
const TOURNAMENT_ENTRANTS = `
query Entrants($slug: String!, $ids: [ID]) {
  tournament(slug: $slug) {
    id name slug startAt city countryCode
    images { type url }
    events(limit: 20, filter: { videogameId: $ids }) {
      id name numEntrants videogame { id name }
      phases {
        id phaseOrder
        seeds(query: { perPage: 16, page: 1 }) {
          nodes { seedNum entrant { id name participants { images { type url } player { id } } } }
        }
      }
    }
  }
}`;

function logoFrom(images = []) {
  return images.find((i) => i.type === 'profile')?.url
    || images.find((i) => i.type === 'banner')?.url
    || null;
}

async function upsertTournament(t) {
  // Full timestamp for the DB column — start.gg's startAt carries the real
  // start hour, not just the calendar date. Keep a plain date-only string
  // around too, purely for the human-readable name-disambiguation suffix.
  const date = new Date(t.startAt * 1000).toISOString();
  const dateOnly = date.slice(0, 10);
  const logoUrl = logoFrom(t.images);
  const existing = await db.getAsync('SELECT id FROM tournaments WHERE startgg_id = ?', [t.id]);
  const nameTaken = await db.getAsync('SELECT id FROM tournaments WHERE name = ? AND id != ?', [t.name, existing?.id ?? -1]);
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

function topSeeds(entrants = [], top) {
  return [...entrants]
    .map((e) => ({ ...e, seedNum: e.seeds?.[0]?.seedNum ?? Infinity }))
    .sort((a, b) => a.seedNum - b.seedNum)
    .slice(0, top);
}

// Reserved synthetic entrant representing every unlisted player ("the field").
async function upsertFieldPlayer() {
  const existing = await db.getAsync('SELECT id FROM players WHERE name = ?', [FIELD_PLAYER_NAME]);
  if (existing) return existing.id;
  const res = await db.runAsync('INSERT INTO players (name, country) VALUES (?, ?)', [FIELD_PLAYER_NAME, '']);
  return res.lastID;
}

// Store an entrant with its seed, seed-based fair probability, and fixed odds.
// Re-runs refresh seed/prob/odds (seeding finalizes near event time) but never
// after results are in (is_winner set).
async function addEntrant(tournamentId, gameId, playerId, { seedNum = null, winProb = null, odds = 1.0 } = {}) {
  await db.runAsync(
    `INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, seed_num, win_probability, live_odds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(tournament_id, game_id, player_id) DO UPDATE
       SET seed_num = excluded.seed_num,
           win_probability = excluded.win_probability,
           live_odds = excluded.live_odds
       WHERE players_games_tournaments.is_winner IS NULL
          OR players_games_tournaments.is_winner = 0`,
    [tournamentId, gameId, playerId, seedNum, winProb, odds]
  );
}

// Top `n` real seeds for an event: take the entry phase (lowest phaseOrder),
// keep seeds with a real entrant + numeric seedNum, sort by seedNum, slice.
// Returns [{ seedNum, entrant }]. Exposed for testing.
function pickTopSeeds(ev, n) {
  const phases = (ev.phases || []).slice().sort((a, b) => (a.phaseOrder ?? 0) - (b.phaseOrder ?? 0));
  const nodes = (phases[0]?.seeds?.nodes || [])
    .filter((s) => s && s.entrant && s.entrant.id != null && Number.isFinite(s.seedNum))
    .sort((a, b) => a.seedNum - b.seedNum)
    .slice(0, n);
  return nodes;
}

async function processTournament(slug, args) {
  const data = await gql(TOURNAMENT_ENTRANTS, { slug, ids: GAME_IDS });
  const t = data?.tournament;
  if (!t) return { events: 0, players: 0 };

  // Events on a tracked game. numEntrants is often null for majors more than a
  // few weeks out (registration data hasn't populated), so DON'T gate the
  // tournament's existence on it — only its futures (priced below) need counts.
  const trackedEvents = (t.events || []).filter((ev) => ev.videogame && GAME_IDS.includes(Number(ev.videogame.id)));
  if (trackedEvents.length === 0) return { events: 0, players: 0, recorded: false };

  // Always record the tournament so it appears on the page (with a countdown),
  // even before futures open or entrant counts are reported.
  const tournamentId = args.dryRun ? null : await upsertTournament(t);

  // Register game associations for ALL tracked events up-front, so the Live
  // page's waiting-room pill can show what games a tournament will feature even
  // before any entrant seedings exist.
  if (!args.dryRun && tournamentId) {
    for (const ev of trackedEvents) {
      const gameId = await upsertGame(ev.videogame);
      await upsertTournamentGame(tournamentId, gameId);
    }
  }

  // Futures only open once an event is genuinely seeded. Far-future majors
  // aren't seeded yet and report provisional/huge seed values, so we gate on
  // (a) being within a few weeks of the start and (b) the top seeds looking
  // real (a low seed actually present).
  const daysOut = (t.startAt * 1000 - Date.now()) / 86400000;
  const futuresOpen = daysOut <= FUTURES_WINDOW_DAYS;

  let eventCount = 0;
  let playerCount = 0;

  for (const ev of trackedEvents) {
    if ((ev.numEntrants || 0) <= 0) continue; // no entrant data yet -> countdown only
    const seedNodes = pickTopSeeds(ev, args.top);
    if (seedNodes.length === 0) continue;
    const minSeed = seedNodes[0].seedNum;
    const seedsLookReal = minSeed <= SEED_SANITY_MAX; // real seeding -> seed 1 present
    if (!futuresOpen || !seedsLookReal) continue; // tournament still shows (countdown)

    if (args.dryRun) {
      console.log(`   ${ev.videogame.name}: ${seedNodes.map((s) => s.entrant.name).join(', ')}`);
      eventCount++; playerCount += seedNodes.length;
      continue;
    }

    const gameId = await upsertGame(ev.videogame);
    // Record the event's start.gg entrant count for the Futures page badge.
    await upsertEntrantCount(tournamentId, gameId, ev.numEntrants);

    // Replace this game's prior futures entrants (those with no bets and no
    // result) with the current top 16, so re-syncs don't accumulate stale or
    // duplicate seeds. Entrants someone has bet on are preserved.
    await db.runAsync(
      `DELETE FROM players_games_tournaments
       WHERE tournament_id = ? AND game_id = ?
         AND (is_winner IS NULL OR is_winner = 0)
         AND NOT EXISTS (
           SELECT 1 FROM bets b
           WHERE b.tournament_id = players_games_tournaments.tournament_id
             AND b.game_id = players_games_tournaments.game_id
             AND b.player_id = players_games_tournaments.player_id)`,
      [tournamentId, gameId]
    );

    // Price by RANK (1..N) for a robust 1/seed ladder, but display the real
    // start.gg seedNum.
    const { players: probs, field } = fieldProbabilities(seedNodes.map((_, i) => i + 1));

    for (let i = 0; i < seedNodes.length; i++) {
      const pid = await findOrCreatePlayerId(seedNodes[i].entrant);
      if (!pid) continue;
      await addEntrant(tournamentId, gameId, pid, {
        seedNum: seedNodes[i].seedNum,
        winProb: probs[i].prob,
        odds: probs[i].odds,
      });
      playerCount++;
    }

    // One "Field" entrant for everyone outside the listed seeds (skip if the
    // listed seeds already cover essentially the whole field).
    if (field.prob > 0.005) {
      const fieldPid = await upsertFieldPlayer();
      await addEntrant(tournamentId, gameId, fieldPid, { seedNum: null, winProb: field.prob, odds: field.odds });
    }

    eventCount++;
  }
  return { events: eventCount, players: playerCount, recorded: !args.dryRun };
}

// Find unique tournament slugs matching the curated brands in a date window.
async function findBrandTournaments(query, after, before) {
  const seen = new Map(); // slug -> name
  // Page through each brand's matches (most brands fit in one page; World Warrior
  // spans several across all regions). Stop a brand once a short page comes back.
  const MAX_PAGES = 6;
  for (const brand of BRANDS) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      let nodes;
      try {
        const data = await gql(query, { name: brand.search, after, before, ids: GAME_IDS, page });
        nodes = data?.tournaments?.nodes || [];
      } catch (err) {
        console.error(`Brand "${brand.search}" p${page} search failed: ${err.message}`);
        break;
      }
      for (const t of nodes) {
        if (!t.slug || seen.has(t.slug)) continue;
        if (!brand.re.test(normalizeName(t.name))) {
          // Silent rejections here are invisible by construction — this is
          // exactly how Battle Arena Melbourne went unmatched for 3 straight
          // editions (BAM 14/15/16): start.gg's own search found it every
          // time, our ^-anchored regex just never said so out loud. Flag the
          // specific, actionable case — the candidate plainly contains the
          // brand's own search phrase, so a human should look at why the
          // regex didn't match, rather than assume it's a correctly-
          // rejected decoy (most rejections ARE decoys, e.g. "Genesis Cup"
          // for the "Genesis" search, and those stay silent on purpose).
          if (normalizeName(t.name).toLowerCase().includes(brand.search.toLowerCase())) {
            console.warn(`[sync-upcoming] possible missed major: "${t.name}" [${t.slug}] contains brand search "${brand.search}" but its regex didn't match — check BRANDS' pattern for this brand.`);
          }
          continue;
        }
        // Skip the "... Community Tournaments" companion pages start.gg spins up
        // for side/legacy games at a major — the main bracket is the real event.
        if (/\bcommunity tournaments?\b/i.test(t.name)) continue;
        seen.set(t.slug, t.name);
      }
      if (nodes.length < 25) break; // last page for this brand
    }
  }
  return seen;
}

// Future page: upcoming major tournaments + their top seeds.
async function syncUpcoming({ months = 12, top = 8, dryRun = false } = {}) {
  if (!dryRun) await applyFuturesMetaSchema();
  const now = Math.floor(Date.now() / 1000);
  const before = now + months * 30 * 86400;
  console.log(`[sync-upcoming] next ${months} months, top ${top} seeds${dryRun ? ' [DRY RUN]' : ''}`);

  const seen = await findBrandTournaments(BRAND_SEARCH, now, before);
  console.log(`[sync-upcoming] found ${seen.size} upcoming major tournament(s).`);

  // Also sweep a plain date-range window around "now" (see NEAR_NOW_WINDOW_DAYS
  // above) to catch anything start.gg's upcoming/past booleans miss while it's
  // in progress — processTournament seeds an already-started event exactly
  // the same way as an upcoming one.
  const nearNow = await findBrandTournaments(
    NEAR_NOW_BRAND_SEARCH, now - NEAR_NOW_WINDOW_DAYS * 86400, now + NEAR_NOW_WINDOW_DAYS * 86400
  );
  let nearNowNew = 0;
  for (const [slug, name] of nearNow) {
    if (!seen.has(slug)) { seen.set(slug, name); nearNowNew++; }
  }
  if (nearNowNew > 0) {
    console.log(`[sync-upcoming] +${nearNowNew} tournament(s) near "now" needing a seeding pass.`);
  }

  let totalEvents = 0, totalPlayers = 0, withData = 0, countdownOnly = 0;
  for (const [slug, name] of seen) {
    try {
      const { events, players, recorded } = await processTournament(slug, { top, dryRun });
      if (events > 0) {
        withData++; totalEvents += events; totalPlayers += players;
        console.log(`  ${name} [${slug}]: ${events} game(s), ${players} entrant(s)`);
      } else if (recorded) {
        countdownOnly++;
        console.log(`  ${name} [${slug}]: countdown only (futures not open yet)`);
      }
    } catch (err) {
      console.error(`  Failed on ${slug}: ${err.message}`);
    }
  }
  console.log(`[sync-upcoming] done: ${withData} with futures + ${countdownOnly} countdown-only, ${totalEvents} games, ${totalPlayers} entrants.`);
  return { tournaments: withData, countdownOnly, events: totalEvents, players: totalPlayers };
}

// Past page: record recently-completed major Grand Finals winners.
async function syncRecentResults({ days = 30, minEntrants = 0 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const after = now - days * 86400;
  console.log(`[sync-results] majors completed in the last ${days} days`);

  const seen = await findBrandTournaments(PAST_BRAND_SEARCH, after, now);
  console.log(`[sync-results] found ${seen.size} recently-completed major tournament(s).`);

  const gameIdSet = new Set(GAME_IDS);
  let totalMatches = 0, withData = 0;
  for (const [slug, name] of seen) {
    try {
      const recorded = await recordPastResults(slug, gameIdSet, { minEntrants, dryRun: false });
      if (recorded > 0) {
        withData++; totalMatches += recorded;
        console.log(`  ${name} [${slug}]: ${recorded} result(s)`);
      }
    } catch (err) {
      console.error(`  Failed on ${slug}: ${err.message}`);
    }
  }
  console.log(`[sync-results] done: ${totalMatches} results across ${withData} tournaments.`);
  return { tournaments: withData, matches: totalMatches };
}

module.exports = { syncUpcoming, syncRecentResults, processTournament, pickTopSeeds, GAME_IDS, BRANDS, normalizeName };

// CLI: `node scripts/sync-upcoming.js [--months N] [--top N] [--dry-run] [--results]`
if (require.main === module) {
  const args = parseArgs(process.argv);
  const run = args.results
    ? syncRecentResults({ days: args.days })
    : syncUpcoming({ months: args.months, top: args.top, dryRun: args.dryRun });
  run.then(() => process.exit(0)).catch((err) => { console.error(`\nSync stopped: ${err.message}`); process.exit(1); });
}
