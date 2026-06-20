// Pick'em scoring — pure math (spec §3). Covers acceptance cases 4, 6, 7.
const { test } = require('node:test');
const assert = require('node:assert');
const { roundMultiplier, upsetMultiplier, computePoints, computeCoins } = require('../../pickem/scoring');

// Case 4 — worked examples from §3 produce the stated points/coins.
test('worked example: R1 favorite (80% backing) wins -> 125 pts, 63 coins', () => {
  const pts = computePoints({ round: 'r1', communityShare: 0.8 });
  assert.equal(pts, 125);
  assert.equal(computeCoins(pts), 63);
});

test('worked example: grand-finals underdog (30% backing) wins -> 900 pts, 450 coins', () => {
  const pts = computePoints({ round: 'gf', communityShare: 0.3 });
  assert.equal(pts, 900);
  assert.equal(computeCoins(pts), 450);
});

test('worked example: top-8 even match (50%) wins -> 350 pts, 175 coins', () => {
  const pts = computePoints({ round: 'top8', communityShare: 0.5 });
  assert.equal(pts, 350);
  assert.equal(computeCoins(pts), 175);
});

// Case 6 — upset multiplier honors UPSET_CAP; favorite floors at 1.0.
test('upset multiplier caps at 3.0 for very low community share', () => {
  assert.equal(upsetMultiplier(0.3), 3.0);   // 1/0.3 = 3.33 -> capped 3.0
  assert.equal(upsetMultiplier(0.1), 3.0);   // 1/0.1 = 10   -> capped 3.0
  assert.equal(upsetMultiplier(0.0001), 3.0);
});

test('upset multiplier floors at 1.0 for a heavy favorite', () => {
  assert.equal(upsetMultiplier(1.0), 1.0);   // unanimous pick -> no bonus
  // share > some threshold still never goes below 1.0
  assert.ok(upsetMultiplier(0.95) >= 1.0);
});

// Case 7 — round multiplier applied per round; GF worth 3x.
test('round multipliers match the spec table', () => {
  assert.equal(roundMultiplier('r1'), 1.0);
  assert.equal(roundMultiplier('r2'), 1.25);
  assert.equal(roundMultiplier('r3'), 1.5);
  assert.equal(roundMultiplier('top8'), 1.75);
  assert.equal(roundMultiplier('top4'), 2.0);
  assert.equal(roundMultiplier('gf'), 3.0);
});

test('grand finals is worth 3x base for an even pick', () => {
  // even (50%) pick: upset mult = 1/0.5 = 2.0; gf round mult = 3.0
  assert.equal(computePoints({ round: 'gf', communityShare: 0.5 }), 600); // 100 * 3 * 2
});

test('unknown round throws', () => {
  assert.throws(() => roundMultiplier('quarters'), /Unknown pick'em round/);
});
