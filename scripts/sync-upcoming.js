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
// Reuse the backfill's main-event Grand Finals recorder for the recent-results sync.
const { processTournament: recordPastResults } = require('./backfill-results');

// Tracked fighting games (start.gg videogame ids), same set as the backfill.
const GAME_IDS = [43868, 49783, 33945, 48599, 1386, 1, 36963, 287, 48548, 73221];

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
  { search: 'Genesis',                 re: /^genesis\s+(x\b|\d|[ivxlcdm]+\b)/i },
  { search: 'Super Smash Con',         re: /^super\s+smash\s+con\b/i },
  { search: 'Battle Arena Melbourne',  re: /^battle\s+arena\s+melbourne\b/i },
  { search: 'Tekken World Tour',       re: /^tekken\s+world\s+tour\b/i },
  { search: 'Ultimate Fighting Arena', re: /^ultimate\s+fighting\s+arena\b/i },
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
query UpcomingBrand($name: String!, $after: Timestamp!, $before: Timestamp!, $ids: [ID]) {
  tournaments(query: { perPage: 25, page: 1, sortBy: "startAt asc",
    filter: { name: $name, upcoming: true, afterDate: $after, beforeDate: $before, videogameIds: $ids } }) {
    nodes { id name slug startAt city countryCode images { type url } }
  }
}`;

const PAST_BRAND_SEARCH = `
query RecentBrand($name: String!, $after: Timestamp!, $before: Timestamp!, $ids: [ID]) {
  tournaments(query: { perPage: 25, page: 1, sortBy: "startAt desc",
    filter: { name: $name, past: true, afterDate: $after, beforeDate: $before, videogameIds: $ids } }) {
    nodes { slug name }
  }
}`;

const TOURNAMENT_ENTRANTS = `
query Entrants($slug: String!, $ids: [ID]) {
  tournament(slug: $slug) {
    id name slug startAt city countryCode
    images { type url }
    events(limit: 20, filter: { videogameId: $ids }) {
      id name numEntrants videogame { id name }
      entrants(query: { perPage: 16, page: 1 }) {
        nodes { id name seeds { seedNum } }
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
  const date = new Date(t.startAt * 1000).toISOString().slice(0, 10);
  const logoUrl = logoFrom(t.images);
  const existing = await db.getAsync('SELECT id FROM tournaments WHERE startgg_id = ?', [t.id]);
  const nameTaken = await db.getAsync('SELECT id FROM tournaments WHERE name = ? AND id != ?', [t.name, existing?.id ?? -1]);
  const name = nameTaken ? `${t.name} (${date})` : t.name;
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

async function upsertPlayer(entrant) {
  const name = entrant?.name?.trim();
  if (!name) return null;
  const existing = await db.getAsync('SELECT id FROM players WHERE startgg_id = ? OR name = ?', [entrant.id, name]);
  if (existing) {
    await db.runAsync('UPDATE players SET startgg_id = COALESCE(startgg_id, ?) WHERE id = ?', [entrant.id, existing.id]);
    return existing.id;
  }
  const result = await db.runAsync('INSERT INTO players (name, country, startgg_id) VALUES (?, ?, ?)', [name, '', entrant.id]);
  return result.lastID;
}

function topSeeds(entrants = [], top) {
  return [...entrants]
    .map((e) => ({ ...e, seedNum: e.seeds?.[0]?.seedNum ?? Infinity }))
    .sort((a, b) => a.seedNum - b.seedNum)
    .slice(0, top);
}

async function addEntrant(tournamentId, gameId, playerId) {
  // Keep a starting live_odds of 1.0; the bet endpoint recalculates it once
  // wagers come in. Don't clobber odds on re-run.
  await db.runAsync(
    `INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, live_odds, created_at)
     VALUES (?, ?, ?, 1.0, CURRENT_TIMESTAMP)
     ON CONFLICT(tournament_id, game_id, player_id) DO NOTHING`,
    [tournamentId, gameId, playerId]
  );
}

async function processTournament(slug, args) {
  const data = await gql(TOURNAMENT_ENTRANTS, { slug, ids: GAME_IDS });
  const t = data?.tournament;
  if (!t) return { events: 0, players: 0 };

  const events = (t.events || []).filter((ev) => ev.videogame && GAME_IDS.includes(Number(ev.videogame.id)) && (ev.numEntrants || 0) > 0);
  if (events.length === 0) return { events: 0, players: 0 };

  let tournamentId = null;
  let eventCount = 0;
  let playerCount = 0;

  for (const ev of events) {
    const seeds = topSeeds(ev.entrants?.nodes || [], args.top);
    if (seeds.length === 0) continue;

    if (args.dryRun) {
      console.log(`   ${ev.videogame.name}: ${seeds.map((s) => s.name).join(', ')}`);
      eventCount++; playerCount += seeds.length;
      continue;
    }

    if (tournamentId === null) tournamentId = await upsertTournament(t);
    const gameId = await upsertGame(ev.videogame);
    for (const s of seeds) {
      const pid = await upsertPlayer(s);
      if (pid) { await addEntrant(tournamentId, gameId, pid); playerCount++; }
    }
    eventCount++;
  }
  return { events: eventCount, players: playerCount };
}

// Find unique tournament slugs matching the curated brands in a date window.
async function findBrandTournaments(query, after, before) {
  const seen = new Map(); // slug -> name
  for (const brand of BRANDS) {
    try {
      const data = await gql(query, { name: brand.search, after, before, ids: GAME_IDS });
      for (const t of data?.tournaments?.nodes || []) {
        if (!t.slug || seen.has(t.slug)) continue;
        if (!brand.re.test(normalizeName(t.name))) continue;
        seen.set(t.slug, t.name);
      }
    } catch (err) {
      console.error(`Brand "${brand.search}" search failed: ${err.message}`);
    }
  }
  return seen;
}

// Future page: upcoming major tournaments + their top seeds.
async function syncUpcoming({ months = 12, top = 8, dryRun = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const before = now + months * 30 * 86400;
  console.log(`[sync-upcoming] next ${months} months, top ${top} seeds${dryRun ? ' [DRY RUN]' : ''}`);

  const seen = await findBrandTournaments(BRAND_SEARCH, now, before);
  console.log(`[sync-upcoming] found ${seen.size} upcoming major tournament(s).`);

  let totalEvents = 0, totalPlayers = 0, withData = 0;
  for (const [slug, name] of seen) {
    try {
      const { events, players } = await processTournament(slug, { top, dryRun });
      if (events > 0) {
        withData++; totalEvents += events; totalPlayers += players;
        console.log(`  ${name} [${slug}]: ${events} game(s), ${players} entrant(s)`);
      }
    } catch (err) {
      console.error(`  Failed on ${slug}: ${err.message}`);
    }
  }
  console.log(`[sync-upcoming] done: ${withData} tournaments, ${totalEvents} games, ${totalPlayers} entrants.`);
  return { tournaments: withData, events: totalEvents, players: totalPlayers };
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

module.exports = { syncUpcoming, syncRecentResults };

// CLI: `node scripts/sync-upcoming.js [--months N] [--top N] [--dry-run] [--results]`
if (require.main === module) {
  const args = parseArgs(process.argv);
  const run = args.results
    ? syncRecentResults({ days: args.days })
    : syncUpcoming({ months: args.months, top: args.top, dryRun: args.dryRun });
  run.then(() => process.exit(0)).catch((err) => { console.error(`\nSync stopped: ${err.message}`); process.exit(1); });
}
