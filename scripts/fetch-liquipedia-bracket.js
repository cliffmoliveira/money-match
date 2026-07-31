// Fetches an EWC (or any Liquipedia-tracked) main-stage Finals Bracket from
// Liquipedia and generates a draft data/manual-results/<manualId>.json for
// scripts/ingest-manual-results.js — see docs/manual-results-ingestion.md.
//
// Why this exists: EWC's main stage runs on its own platform, never
// start.gg, so nothing about it can sync automatically (see
// docs/manual-results-ingestion.md). Hand-transcribing every set from a
// broadcast VOD doesn't scale across 3 games x however many years EWC runs.
// Liquipedia already tracks these brackets structurally (via their
// {{ShowBracket}} template, backed by a match-group store, not visible in
// raw wikitext) - this fetches the RENDERED page HTML (where that template
// resolves to real markup) and parses the single-elimination Finals Bracket
// out of it.
//
// Deliberately does NOT invent the tournament metadata or resolve player
// names to this app's "SPONSOR | tag" convention - it only extracts bracket
// STRUCTURE (round labels, pairings, scores, winners), which is the
// error-prone part to transcribe by hand. Every player name comes through
// exactly as Liquipedia's bare gamertag; ingest-manual-results.js already
// fails loudly with near-match suggestions against players.name, which is
// the right place for that resolution to happen with a human looking at it
// - reproducing that logic here would just be a second, unreviewed place to
// get it wrong.
//
// Only ever extracts the bracket wrapper containing "Grand Final" text (the
// single-elim Finals Bracket) - group/pool stages elsewhere on the same
// page are ignored, matching this app's existing Top-8-only tracking scope
// (see liveMarkets.js / bracket_history's own pre-Top-8 vs set_markets
// split). Refuses to write anything until every non-third-place match has a
// decisive score, so running it mid-event just reports progress instead of
// producing a partial file someone could accidentally ingest.
//
// Usage:
//   node scripts/fetch-liquipedia-bracket.js <LiquipediaPagePath> <manualId> [--out <path>]
//
// Example:
//   node scripts/fetch-liquipedia-bracket.js Esports_World_Cup/2026/SF6 ewc-2026-sf6 \
//     --out data/manual-results/ewc-2026-sf6.json
//
// The wiki is hardcoded to Liquipedia's fighting-games wiki (liquipedia.net/fighters) -
// every EWC fighting-game bracket lives there.

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const WIKI_API = 'https://liquipedia.net/fighters/api.php';
const USER_AGENT = 'HitConfirmedApp/1.0 (https://github.com/HitConfirmed/hitconfirmed.com; contact via repo)';

function fail(msg) {
  throw new Error(msg);
}

async function fetchPageHtml(pagePath) {
  const url = `${WIKI_API}?action=parse&page=${encodeURIComponent(pagePath)}&format=json&prop=text`;
  // Liquipedia's API rejects requests that don't advertise gzip support
  // (see liquipedia.net/api-terms-of-use) - fetch() handles decoding
  // transparently as long as Accept-Encoding is sent.
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' },
  });
  if (!res.ok) fail(`Liquipedia API request failed: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    fail(`Liquipedia API error for page "${pagePath}": ${data.error.info || data.error.code}`);
  }
  return data.parse.text['*'];
}

// Round label -> this app's roundInt convention (docs/manual-results-ingestion.md:
// single-elim counts QF 1, SF 2, GF 3).
const ROUND_INT_BY_LABEL = { Quarterfinals: 1, Semifinals: 2, 'Grand Final': 3 };

function extractMatch($, matchEl) {
  const opponents = $(matchEl).find('.brkts-opponent-entry');
  if (opponents.length !== 2) return null;
  const names = opponents.map((i, o) => $(o).attr('aria-label') || $(o).text().trim()).get();
  const scores = $(matchEl)
    .find('.match-info-header-scoreholder-score')
    .map((i, s) => $(s).text().trim())
    .get();
  const p1Won = $(opponents[0]).find('> div').first().hasClass('brkts-opponent-win');
  const p2Won = $(opponents[1]).find('> div').first().hasClass('brkts-opponent-win');
  const decided = scores.length === 2 && scores.every((s) => s !== '' && !Number.isNaN(Number(s))) && (p1Won || p2Won);
  return {
    p1: names[0], p2: names[1],
    p1Score: decided ? Number(scores[0]) : null,
    p2Score: decided ? Number(scores[1]) : null,
    decided,
  };
}

function extractFinalsBracket($) {
  const wrappers = $('.brkts-bracket-wrapper').filter((i, el) => $(el).text().includes('Grand Final'));
  if (wrappers.length === 0) {
    fail('No bracket on this page contains a "Grand Final" round - either the page has no Finals Bracket section yet, or its structure changed.');
  }
  const bracket = wrappers.first().find('.brkts-bracket').first();

  const roundLabels = bracket
    .find('> .brkts-round-header > .brkts-header')
    .map((i, el) => $(el).clone().children().remove().end().text().trim())
    .get();

  const body = bracket.children('.brkts-round-body');
  // Direct children only - .brkts-round-center's class also shows up nested
  // inside each match's popup-detail markup, so a plain .find() over-matches.
  const lowerMatches = body.children('.brkts-round-lower').find('.brkts-match').not('.brkts-third-place-match')
    .map((i, el) => extractMatch($, el)).get().filter(Boolean);
  const centerMatches = body.children('.brkts-round-center').find('.brkts-match').not('.brkts-third-place-match')
    .map((i, el) => extractMatch($, el)).get().filter(Boolean);

  // This app only ever tracks EWC's 8-player Finals Bracket (2026 format:
  // 2x GSL groups, top 4 each advance to an 8-man single-elim playoff) -
  // Liquipedia renders that shape as exactly 6 matches interleaved
  // QF,QF,SF,QF,QF,SF in the "lower" column, then the Grand Final alone in
  // "center". A different match count means either the format changed or
  // this page isn't the 8-player Finals Bracket - fail loudly rather than
  // guess at a round mapping that might silently mislabel a set.
  if (lowerMatches.length !== 6 || centerMatches.length !== 1) {
    fail(
      `Unexpected bracket shape: ${lowerMatches.length} matches in the QF/SF column (expected 6) and ` +
      `${centerMatches.length} in the Grand Final column (expected 1). This script only handles the ` +
      'standard 8-player EWC Finals Bracket - inspect the page manually if the format changed.'
    );
  }
  if (roundLabels.length !== 3 || roundLabels[0] !== 'Quarterfinals' || roundLabels[1] !== 'Semifinals' || roundLabels[2] !== 'Grand Final') {
    fail(`Unexpected round labels: ${JSON.stringify(roundLabels)} (expected Quarterfinals, Semifinals, Grand Final).`);
  }

  const [qf1, qf2, sf1, qf3, qf4, sf2] = lowerMatches;
  const [gf] = centerMatches;
  return [
    { round: 'Quarter-Final', roundInt: ROUND_INT_BY_LABEL.Quarterfinals, ...qf1 },
    { round: 'Quarter-Final', roundInt: ROUND_INT_BY_LABEL.Quarterfinals, ...qf2 },
    { round: 'Quarter-Final', roundInt: ROUND_INT_BY_LABEL.Quarterfinals, ...qf3 },
    { round: 'Quarter-Final', roundInt: ROUND_INT_BY_LABEL.Quarterfinals, ...qf4 },
    { round: 'Semi-Final', roundInt: ROUND_INT_BY_LABEL.Semifinals, ...sf1 },
    { round: 'Semi-Final', roundInt: ROUND_INT_BY_LABEL.Semifinals, ...sf2 },
    { round: 'Grand Final', roundInt: ROUND_INT_BY_LABEL['Grand Final'], ...gf },
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const outFlagIdx = args.indexOf('--out');
  const outPath = outFlagIdx >= 0 ? args[outFlagIdx + 1] : null;
  const positional = outFlagIdx < 0 ? args : args.filter((a, i) => i !== outFlagIdx && i !== outFlagIdx + 1);
  const [pagePath, manualId] = positional;
  if (!pagePath || !manualId) {
    fail('usage: node scripts/fetch-liquipedia-bracket.js <LiquipediaPagePath> <manualId> [--out <path>]');
  }

  console.log(`Fetching https://liquipedia.net/fighters/${pagePath} ...`);
  const html = await fetchPageHtml(pagePath);
  const $ = cheerio.load(html);
  const sets = extractFinalsBracket($);

  const decided = sets.filter((s) => s.decided).length;
  console.log(`${decided}/${sets.length} Finals Bracket sets decided:`);
  for (const s of sets) {
    const status = s.decided ? `${s.p1Score}-${s.p2Score}` : 'not yet played';
    console.log(`  [${s.round}] ${s.p1} vs ${s.p2}: ${status}`);
  }

  if (decided < sets.length) {
    console.log(`\nNot finished yet - re-run once the Grand Final concludes. No file written.`);
    return;
  }

  const draft = {
    manualId,
    tournament: {
      name: 'FILL ME IN - exact display name, also the upsert key',
      date: 'FILL ME IN - ISO date, must be within the UI\'s year filter',
      city: 'FILL ME IN', country: 'FILL ME IN',
      logoUrl: null,
    },
    game: 'FILL ME IN - EXACT games.name',
    numEntrants: 8,
    sets: sets.map((s, i) => ({
      n: i + 1, round: s.round, roundInt: s.roundInt,
      p1: `FILL ME IN (Liquipedia: "${s.p1}")`,
      p2: `FILL ME IN (Liquipedia: "${s.p2}")`,
      p1Score: s.p1Score, p2Score: s.p2Score,
      at: 'FILL ME IN - YYYY-MM-DD HH:MM:SS',
    })),
  };

  const dest = outPath || path.join(__dirname, '..', 'data', 'manual-results', `${manualId}.json`);
  fs.writeFileSync(dest, JSON.stringify(draft, null, 2) + '\n');
  console.log(`\nWrote draft to ${dest}.`);
  console.log('Still needs by hand before ingesting: tournament name/date/city/country, game name, and');
  console.log('every player\'s exact players.name (Liquipedia only gives bare gamertags - cross-check');
  console.log('against the DB; ingest-manual-results.js will fail loudly with near-match suggestions for typos).');
}

module.exports = { extractFinalsBracket, extractMatch };

if (require.main === module) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
