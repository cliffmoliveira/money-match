const { test } = require('node:test');
const assert = require('node:assert');
const cheerio = require('cheerio');
const { extractFinalsBracket, extractGroupStages } = require('../../scripts/fetch-liquipedia-bracket');

// Minimal fixture reproducing the real Liquipedia bracket DOM shape (see
// scripts/fetch-liquipedia-bracket.js's own comments for how this was
// reverse-engineered against the live, completed EWC 2026 Fatal Fury page).
// Runs offline against a fixed fixture rather than the network so this
// suite doesn't depend on Liquipedia being up or a bracket staying frozen.
function match({ p1, p2, p1Score, p2Score, thirdPlace = false }) {
  const decided = p1Score != null;
  const p1Win = decided && p1Score > p2Score;
  const p2Win = decided && p2Score > p1Score;
  const scores = decided
    ? `<span class="match-info-header-scoreholder-score">${p1Score}</span><span class="match-info-header-scoreholder-score">${p2Score}</span>`
    : '';
  return `<div class="brkts-match brkts-match-popup-wrapper${thirdPlace ? ' brkts-third-place-match' : ''}">
    <div class="brkts-opponent-entry" aria-label="${p1}"><div class="brkts-opponent-entry-left${p1Win ? ' brkts-opponent-win' : ''}"></div></div>
    <div class="brkts-opponent-entry" aria-label="${p2}"><div class="brkts-opponent-entry-left${p2Win ? ' brkts-opponent-win' : ''}"></div></div>
    ${scores}
  </div>`;
}

function header(label) {
  return `<div class="brkts-header brkts-header-div">${label}<div class="brkts-header-option">${label}</div></div>`;
}

function bracketHtml({ lower, center }) {
  return `<div class="brkts-bracket-wrapper">Grand Final
    <div class="brkts-bracket">
      <div class="brkts-round-header">
        ${header('Quarterfinals')}${header('Semifinals')}${header('Grand Final')}
      </div>
      <div class="brkts-round-body">
        <div class="brkts-round-lower">${lower.join('')}</div>
        <div class="brkts-round-lower-connectors"></div>
        <div class="brkts-round-center">${center.join('')}</div>
      </div>
    </div>
  </div>`;
}

const COMPLETE_BRACKET = bracketHtml({
  lower: [
    match({ p1: 'Laggia', p2: 'ZJZ', p1Score: 5, p2Score: 2 }),
    match({ p1: 'NaiWang', p2: 'Mi2ha4', p1Score: 1, p2Score: 5 }),
    match({ p1: 'Laggia', p2: 'Mi2ha4', p1Score: 4, p2Score: 5 }),
    match({ p1: 'DarkAngel', p2: 'Reynald', p1Score: 5, p2Score: 4 }),
    match({ p1: 'K-TOP', p2: 'Nemo', p1Score: 0, p2Score: 5 }),
    match({ p1: 'DarkAngel', p2: 'Nemo', p1Score: 5, p2Score: 3 }),
  ],
  center: [
    match({ p1: 'Mi2ha4', p2: 'DarkAngel', p1Score: 1, p2Score: 5 }),
    match({ p1: 'Laggia', p2: 'Nemo', p1Score: 2, p2Score: 5, thirdPlace: true }),
  ],
});

test('extracts all 7 sets in the correct round order, ignoring the third-place match', () => {
  const $ = cheerio.load(COMPLETE_BRACKET);
  const sets = extractFinalsBracket($);

  assert.equal(sets.length, 7);
  assert.deepEqual(sets.map((s) => s.round), [
    'Quarter-Final', 'Quarter-Final', 'Quarter-Final', 'Quarter-Final',
    'Semi-Final', 'Semi-Final', 'Grand Final',
  ]);
  assert.deepEqual(sets.map((s) => s.roundInt), [1, 1, 1, 1, 2, 2, 3]);
  assert.ok(sets.every((s) => s.decided));

  const gf = sets[6];
  assert.equal(gf.p1, 'Mi2ha4');
  assert.equal(gf.p2, 'DarkAngel');
  assert.equal(gf.p1Score, 1);
  assert.equal(gf.p2Score, 5);

  // The third-place match never appears among the extracted sets.
  assert.ok(!sets.some((s) => (s.p1 === 'Laggia' && s.p2 === 'Nemo')));
});

test('reports undecided matches instead of fabricating a result', () => {
  const html = bracketHtml({
    lower: [
      match({ p1: 'A', p2: 'B', p1Score: 2, p2Score: 0 }),
      match({ p1: 'C', p2: 'D', p1Score: 2, p2Score: 1 }),
      match({ p1: 'A', p2: 'C' }), // SF not yet played
      match({ p1: 'E', p2: 'F', p1Score: 2, p2Score: 0 }),
      match({ p1: 'G', p2: 'H', p1Score: 2, p2Score: 1 }),
      match({ p1: 'E', p2: 'G' }),
    ],
    center: [
      match({ p1: '', p2: '' }),
      match({ p1: '', p2: '', thirdPlace: true }),
    ],
  });
  const $ = cheerio.load(html);
  const sets = extractFinalsBracket($);

  const decidedCount = sets.filter((s) => s.decided).length;
  assert.equal(decidedCount, 4); // only the 4 QFs
  assert.equal(sets.find((s) => s.round === 'Semi-Final' && s.p1 === 'A').decided, false);
});

test('fails loudly when no Grand Final bracket exists on the page', () => {
  const $ = cheerio.load('<div class="brkts-bracket-wrapper">Group Stage 1, no finals yet</div>');
  assert.throws(() => extractFinalsBracket($), /Grand Final/);
});

test('fails loudly on an unexpected bracket shape instead of mislabeling rounds', () => {
  const html = bracketHtml({
    lower: [match({ p1: 'A', p2: 'B', p1Score: 2, p2Score: 0 })], // only 1, not 6
    center: [match({ p1: 'C', p2: 'D', p1Score: 2, p2Score: 0 })],
  });
  const $ = cheerio.load(html);
  assert.throws(() => extractFinalsBracket($), /Unexpected bracket shape/);
});

// ---- extractGroupStages ----
// Real group-stage matches don't need the round-lower/round-center scaffolding
// extractFinalsBracket relies on - extractGroupStages just finds every
// .brkts-match inside each non-finals wrapper, flat.
function groupWrapperHtml(matches) {
  return `<div class="brkts-bracket-wrapper">Group<div class="brkts-bracket">${matches.join('')}</div></div>`;
}
function tenMatches(prefix) {
  return Array.from({ length: 10 }, (_, i) =>
    match({ p1: `${prefix}${i}a`, p2: `${prefix}${i}b`, p1Score: 3, p2Score: 1 })
  );
}
const FINALS_MARKER = '<div class="brkts-bracket-wrapper">Grand Final marker only</div>';

test('extracts group-stage matches, tagging each with its phase label and group index', () => {
  const html = [
    ...Array.from({ length: 4 }, (_, i) => groupWrapperHtml(tenMatches(`p1g${i}`))),
    ...Array.from({ length: 2 }, (_, i) => groupWrapperHtml(tenMatches(`p2g${i}`))),
    FINALS_MARKER,
  ].join('');
  const $ = cheerio.load(html);
  const matches = extractGroupStages($);

  assert.equal(matches.length, 60); // 6 groups x 10
  assert.equal(matches.filter((m) => m.round === 'Group Stage 1').length, 40);
  assert.equal(matches.filter((m) => m.round === 'Group Stage 2').length, 20);
  assert.ok(matches.every((m) => m.decided));
  // Distinct phaseOrder per group within a phase (0-3 for First Phase).
  const phase1Groups = new Set(matches.filter((m) => m.round === 'Group Stage 1').map((m) => m.phaseOrder));
  assert.deepEqual([...phase1Groups].sort(), [0, 1, 2, 3]);
});

test('a known winner with no recoverable score still counts as decided (nullable in bracket_history)', () => {
  // Reproduces the real EWC 2026 Fatal Fury case: GO1's win is marked via
  // .brkts-opponent-win, but the shared score-holder never rendered at all
  // for that match on Liquipedia's page - an upstream data gap, not a
  // parsing bug. Winner survives; both scores come back null.
  const withMissingScore = match({ p1: 'X', p2: 'Y', p1Score: 3, p2Score: 1 })
    .replace(/<span class="match-info-header-scoreholder-score">3<\/span><span class="match-info-header-scoreholder-score">1<\/span>/, '');
  const groups = [
    ...Array.from({ length: 3 }, (_, i) => groupWrapperHtml(tenMatches(`a${i}`))),
    groupWrapperHtml([...tenMatches('b').slice(1), withMissingScore]),
    ...Array.from({ length: 2 }, (_, i) => groupWrapperHtml(tenMatches(`c${i}`))),
    FINALS_MARKER,
  ];
  const $ = cheerio.load(groups.join(''));
  const matches = extractGroupStages($);

  const partial = matches.find((m) => m.p1 === 'X' && m.p2 === 'Y');
  assert.ok(partial.decided);
  assert.equal(partial.p1Score, null);
  assert.equal(partial.p2Score, null);
  assert.equal(partial.winner, 1);
});

test('fails loudly on an unexpected group-stage wrapper count', () => {
  const html = [groupWrapperHtml(tenMatches('only')), FINALS_MARKER].join('');
  const $ = cheerio.load(html);
  assert.throws(() => extractGroupStages($), /Unexpected group-stage wrapper count/);
});

test('zero group-stage wrappers gets a distinct, recognizable "not started" error, not a generic shape error', () => {
  // Real case: EWC's Tekken 8 page before Aug 4 has no Finals Bracket AND no
  // group-stage wrappers at all yet - callers (fetch-liquipedia-bracket.js's
  // main(), auto-sync-manual-events.js) need to tell "not started" apart
  // from "the page's shape genuinely changed" by message alone.
  const $ = cheerio.load(FINALS_MARKER);
  assert.throws(() => extractGroupStages($), /No group-stage bracket wrappers on this page yet/);
});

test('fails loudly when a group has the wrong number of matches', () => {
  const html = [
    ...Array.from({ length: 3 }, (_, i) => groupWrapperHtml(tenMatches(`a${i}`))),
    groupWrapperHtml(tenMatches('short').slice(0, 5)), // only 5, not 10
    ...Array.from({ length: 2 }, (_, i) => groupWrapperHtml(tenMatches(`c${i}`))),
    FINALS_MARKER,
  ];
  const $ = cheerio.load(html.join(''));
  assert.throws(() => extractGroupStages($), /Unexpected group-stage match count/);
});
