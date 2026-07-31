const { test } = require('node:test');
const assert = require('node:assert');
const cheerio = require('cheerio');
const { extractFinalsBracket } = require('../../scripts/fetch-liquipedia-bracket');

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
