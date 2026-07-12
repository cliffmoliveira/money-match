// Regression suite for scripts/sync-upcoming.js's BRANDS regexes — the
// pattern that silently rejected "BAM 16: Battle Arena Melbourne 16" for
// three straight editions (an ^-anchored regex that never matched the
// organizers' actual "BAM <N>: <full name>" listing title) is exactly the
// class of bug this guards against: every brand gets asserted against at
// least one REAL tournament name (pulled from this app's own synced data
// where available) plus, wherever the source comment calls out a specific
// decoy risk, a name that must NOT match.
//
// This does not replace the live diagnostic in findBrandTournaments (which
// catches drift for names we haven't seen yet) — it catches regressions on
// names we already know about, at test time instead of in production.
const { test } = require('node:test');
const assert = require('node:assert');
const { BRANDS, normalizeName } = require('../../scripts/sync-upcoming');

function brand(name) {
  const b = BRANDS.find((x) => x.search === name);
  assert.ok(b, `no BRANDS entry named "${name}"`);
  return b;
}

function assertMatches(brandName, tournamentName) {
  const b = brand(brandName);
  assert.ok(
    b.re.test(normalizeName(tournamentName)),
    `BRANDS["${brandName}"].re should match "${tournamentName}"`
  );
}

function assertRejects(brandName, tournamentName) {
  const b = brand(brandName);
  assert.ok(
    !b.re.test(normalizeName(tournamentName)),
    `BRANDS["${brandName}"].re should NOT match "${tournamentName}"`
  );
}

test('Evo matches the flagship name and rejects hype-event decoys', () => {
  assertMatches('Evo', 'EVO 2023');
  assertMatches('Evo', 'Evo 2026');
  assertRejects('Evo', 'Pre-Evo Warmup');
  assertRejects('Evo', 'Evolution Crash Course');
});

test('CEO requires a year, so the online subtitle series is excluded', () => {
  assertMatches('CEO', 'CEO 2023');
  assertMatches('CEO', 'CEO 2024');
  assertRejects('CEO', 'CEO: Online Series');
});

test('Combo Breaker matches real editions', () => {
  assertMatches('Combo Breaker', 'COMBO BREAKER 2025');
  assertMatches('Combo Breaker', 'COMBO BREAKER 2026');
});

test('Genesis requires a number/numeral and excludes the online Cup series', () => {
  assertMatches('Genesis', 'Genesis X2');
  assertMatches('Genesis', 'Genesis X3');
  assertRejects('Genesis', 'Genesis Cup');
  assertRejects('Genesis', 'Genesis Saturday Deluxe');
});

test('Frosty Faustings matches real editions', () => {
  assertMatches('Frosty Faustings', 'Frosty Faustings XVI');
  assertMatches('Frosty Faustings', 'Frosty Faustings XVII');
});

test('Texas Showdown matches real editions', () => {
  assertMatches('Texas Showdown', 'Texas Showdown 2025');
  assertMatches('Texas Showdown', 'Texas Showdown 2026');
});

test('VSFighting matches real editions', () => {
  assertMatches('VSFighting', 'VSFighting XIII');
  assertMatches('VSFighting', 'VSFighting XIV');
});

test('DreamHack matches real editions', () => {
  assertMatches('DreamHack', 'DreamHack Atlanta 2025');
  assertMatches('DreamHack', 'DreamHack Fall 2025');
});

test('World Warrior matches anywhere in the name (region/edition varies)', () => {
  assertMatches('World Warrior', 'World Warrior 2026 - US Midwest 3');
  assertMatches('World Warrior', 'BR Kumite - World Warrior 2026 - Brazil 3');
});

test('Esports World Cup matches anywhere in the name', () => {
  assertMatches('Esports World Cup', 'Esports World Cup 2026: FATAL FURY: City of the Wolves - LCQ');
});

// The bug this file exists to prevent: the organizers' start.gg listing
// title is "BAM <N>: Battle Arena Melbourne <N>" — an ^-anchored regex
// silently rejected every real edition (14, 15, 16) because the name starts
// with "BAM <N>:", not "Battle Arena Melbourne". Also asserts two decoy
// local Melbourne events keep being correctly excluded now that the anchor
// is gone.
test('Battle Arena Melbourne matches the real "BAM <N>: ..." listing title', () => {
  assertMatches('Battle Arena Melbourne', 'BAM 14: Battle Arena Melbourne 2024');
  assertMatches('Battle Arena Melbourne', 'BAM 15: Battle Arena Melbourne 15');
  assertMatches('Battle Arena Melbourne', 'BAM 16: Battle Arena Melbourne 16');
  assertRejects('Battle Arena Melbourne', 'Mini Melbourne Pre-Major Dojo');
  assertRejects('Battle Arena Melbourne', 'Ramen Bowl Arena Melbourne #226');
});

test('every BRANDS entry has a non-empty search term and a RegExp pattern', () => {
  for (const b of BRANDS) {
    assert.ok(b.search && typeof b.search === 'string', `brand missing a search string: ${JSON.stringify(b)}`);
    assert.ok(b.re instanceof RegExp, `brand "${b.search}" missing a RegExp pattern`);
  }
});
