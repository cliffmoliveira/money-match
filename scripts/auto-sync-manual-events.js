// Automatically checks Liquipedia for every EWC main-stage event this app
// tracks (see docs/manual-results-ingestion.md) and ingests whatever's newly
// decided - closing the gap that made scripts/fetch-liquipedia-bracket.js +
// scripts/ingest-manual-results.js a manually-triggered process. Runs on a
// schedule (see scheduleManualEventAutoSync in server.js), not on demand.
//
// What it does WITHOUT a human: fetch, parse, and ingest group-stage/Finals
// Bracket data once every player name in it resolves to EXACTLY ONE existing
// players row - safe, since it's the same "never auto-create, exact identity
// only" guarantee ingest-manual-results.js already enforces, just automated.
//
// What it deliberately does NOT do: invent a player, or guess between
// multiple plausible candidates for an ambiguous bare Liquipedia tag (e.g.
// two different sponsor-tagged rows that could both be "SCORE"). Liquipedia
// only ever gives a bare gamertag, never this app's "SPONSOR | tag" name, so
// there's no such thing as a literal name match here - resolution works by
// finding players whose name's LAST sponsor-tag segment (splitting on the
// same separators real tags use: |, 丨, ｜, /) case-insensitively equals the
// bare tag. If that's ambiguous (0 or 2+ candidates) for ANY name in a
// decided batch, the whole batch is skipped rather than partially ingested -
// same all-or-nothing philosophy as fetch-liquipedia-bracket.js itself. Logs
// clearly so it's visible without babysitting server logs (see db.js's own
// boot-diagnostic pattern for stuck markets - same idea, same visibility
// tier: this can't push a notification, only make the problem loud were
// someone to look).

const path = require('path');
const cheerio = require('cheerio');
const db = require('../db/db');
const { fetchPageHtml, extractFinalsBracket, extractGroupStages } = require('./fetch-liquipedia-bracket');
const { ingestSpec } = require('./ingest-manual-results');

// Every EWC 2026 fighting-game event this app tracks. Add a new entry here
// when EWC announces the next one - everything else (fetch cadence,
// resolution, ingestion) is automatic from that point on. `tournament`/`game`
// mirror the exact shape ingest-manual-results.js expects; logoUrl is reused
// from the event's own start.gg LCQ (see docs/manual-results-ingestion.md's
// existing convention) since start.gg has no asset for the main stage itself.
const REGISTRY = [
  {
    manualId: 'ewc-2026-ffcotw',
    liquipediaPage: 'Esports_World_Cup/2026/CotW',
    tournament: {
      name: 'Esports World Cup 2026: FATAL FURY: City of the Wolves',
      city: 'Paris', country: 'FR',
      logoUrl: 'https://images.start.gg/images/tournament/918971/image-e07c0291f27d479306790098cdabeaae.jpg',
    },
    game: 'Fatal Fury: City of the Wolves', numEntrants: 8,
  },
  {
    manualId: 'ewc-2026-sf6',
    liquipediaPage: 'Esports_World_Cup/2026/SF6',
    tournament: {
      name: 'Esports World Cup 2026: Street Fighter 6',
      city: 'Paris', country: 'FR',
      logoUrl: 'https://images.start.gg/images/tournament/919272/image-3e54eeda4a7984a2ec1f63c0a28409bd.jpg',
    },
    game: 'Street Fighter 6', numEntrants: 32,
  },
  {
    manualId: 'ewc-2026-t8',
    liquipediaPage: 'Esports_World_Cup/2026/T8',
    tournament: {
      name: 'Esports World Cup 2026: TEKKEN 8',
      city: 'Paris', country: 'FR',
      logoUrl: 'https://images.start.gg/images/tournament/919284/image-879100a8218d7c9ad927a35af51a3564.jpg',
    },
    game: 'TEKKEN 8', numEntrants: 32,
  },
];

const SEPARATORS = /[|｜丨/]/;

// A bare Liquipedia tag resolves to a players row only when its LAST
// sponsor-tag segment (same separators real tags use) case-insensitively
// equals the bare tag, AND exactly one row matches that way. Loosely
// LIKE-prefilters in SQL (cheap), then checks precisely in JS - a plain SQL
// substring match alone would false-positive (e.g. Liquipedia's "Xian"
// matching inside an unrelated player named "waktuxiang").
async function resolveBareTag(bareTag) {
  const candidates = await db.allAsync(`SELECT id, name FROM players WHERE name LIKE '%' || ? || '%'`, [bareTag]);
  const matches = candidates.filter((c) => {
    const segments = c.name.split(SEPARATORS);
    const last = segments[segments.length - 1].trim();
    return last.toLowerCase() === bareTag.trim().toLowerCase();
  });
  if (matches.length === 1) return matches[0];
  return null; // 0 or 2+ - not safe to auto-resolve
}

async function resolveAllNames(names) {
  const resolved = new Map();
  const unresolved = [];
  for (const name of names) {
    if (resolved.has(name)) continue;
    const match = await resolveBareTag(name);
    if (match) resolved.set(name, match.name);
    else unresolved.push(name);
  }
  return { resolved, unresolved };
}

function extractSection($) {
  let finalsSets = [];
  try {
    finalsSets = extractFinalsBracket($);
  } catch (err) {
    if (!/No bracket on this page contains a "Grand Final" round/.test(err.message)) throw err;
  }
  let groupMatches = [];
  try {
    groupMatches = extractGroupStages($);
  } catch (err) {
    if (!/No group-stage bracket wrappers on this page yet/.test(err.message)) throw err;
  }
  return { finalsSets, groupMatches };
}

async function syncOneEvent(entry) {
  const existing = await db.getAsync('SELECT id, winner_id, date FROM tournaments WHERE name = ?', [entry.tournament.name]);
  if (existing && existing.winner_id != null) {
    return { manualId: entry.manualId, status: 'already-finalized' };
  }

  let html;
  try {
    html = await fetchPageHtml(entry.liquipediaPage);
  } catch (err) {
    console.error(`[auto-sync-manual] ${entry.manualId}: fetch failed - ${err.message}`);
    return { manualId: entry.manualId, status: 'fetch-error', error: err.message };
  }

  let finalsSets, groupMatches;
  try {
    ({ finalsSets, groupMatches } = extractSection(cheerio.load(html)));
  } catch (err) {
    console.error(`[auto-sync-manual] ${entry.manualId}: page shape error - ${err.message}`);
    return { manualId: entry.manualId, status: 'shape-error', error: err.message };
  }

  const finalsDecided = finalsSets.length > 0 && finalsSets.every((s) => s.decided);
  const groupsDecided = groupMatches.length > 0 && groupMatches.every((m) => m.decided);
  if (!finalsDecided && !groupsDecided) {
    return { manualId: entry.manualId, status: 'not-ready' };
  }

  const allNames = new Set();
  if (finalsDecided) finalsSets.forEach((s) => { allNames.add(s.p1); allNames.add(s.p2); });
  if (groupsDecided) groupMatches.forEach((m) => { allNames.add(m.p1); allNames.add(m.p2); });
  const { resolved, unresolved } = await resolveAllNames(allNames);

  if (unresolved.length) {
    console.error(
      `[auto-sync-manual] ${entry.manualId}: ${unresolved.length} player name(s) couldn't be safely auto-resolved ` +
      `(0 or multiple candidates) - skipping this run, needs a human to run scripts/fetch-liquipedia-bracket.js + ` +
      `manually cross-reference: ${unresolved.join(', ')}`
    );
    return { manualId: entry.manualId, status: 'needs-human', unresolved };
  }

  const spec = {
    manualId: entry.manualId,
    // Liquipedia's rendered page doesn't carry the event's real date (that's
    // only in the wikitext infobox, a separate fetch this doesn't make) - use
    // "now" only when this tournament is brand new to us; an existing row
    // keeps whatever date it already has rather than drifting forward every
    // time this job re-checks an in-progress event.
    tournament: { ...entry.tournament, date: existing ? existing.date : new Date().toISOString() },
    game: entry.game,
    numEntrants: entry.numEntrants,
  };
  if (finalsDecided) {
    spec.sets = finalsSets.map((s, i) => ({
      n: i + 1, round: s.round, roundInt: s.roundInt,
      p1: resolved.get(s.p1), p2: resolved.get(s.p2), p1Score: s.p1Score, p2Score: s.p2Score,
    }));
  }
  if (groupsDecided) {
    spec.groupStages = groupMatches.map((m, i) => ({
      n: i + 1, round: m.round, phaseOrder: m.phaseOrder,
      p1: resolved.get(m.p1), p2: resolved.get(m.p2), p1Score: m.p1Score, p2Score: m.p2Score, winner: m.winner,
    }));
  }

  const result = await ingestSpec(spec, { closeDb: false });
  console.log(`[auto-sync-manual] ${entry.manualId}: ingested (finalized=${result.finalized})`);
  return { manualId: entry.manualId, status: 'ingested', finalized: result.finalized };
}

async function autoSyncManualEvents() {
  const results = [];
  for (const entry of REGISTRY) {
    try {
      results.push(await syncOneEvent(entry));
    } catch (err) {
      console.error(`[auto-sync-manual] ${entry.manualId}: unexpected error - ${err.message}`);
      results.push({ manualId: entry.manualId, status: 'error', error: err.message });
    }
  }
  return results;
}

module.exports = { autoSyncManualEvents, syncOneEvent, resolveBareTag, REGISTRY };

if (require.main === module) {
  autoSyncManualEvents().then((results) => {
    console.log(JSON.stringify(results, null, 1));
    process.exit(0);
  }).catch((err) => { console.error(err.message); process.exit(1); });
}
