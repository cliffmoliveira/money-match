// Pure pick'em scoring (spec §3). No DB, no side effects — just the math, so it's
// trivially testable and the settlement pipeline can call it with stored values.
const { BASE, COIN_RATE, UPSET_CAP, ROUND_MULTIPLIERS } = require('./config');

// Later rounds are worth more. Throws on an unknown round so a bad market can't
// silently score as zero-multiplier.
function roundMultiplier(round) {
  const m = ROUND_MULTIPLIERS[round];
  if (m == null) throw new Error(`Unknown pick'em round: ${round}`);
  return m;
}

// Rewards backing who the crowd doubted: the smaller your pick's lock-time
// community share, the bigger the multiplier — clamped to [1.0, UPSET_CAP].
// share is the fraction (0..1) of picks on the market that were on YOUR pick.
function upsetMultiplier(communityShare) {
  if (!(communityShare > 0)) return UPSET_CAP; // defensive: unbacked pick caps out
  return Math.min(UPSET_CAP, Math.max(1.0, 1 / communityShare));
}

// points = BASE * round_multiplier * upset_multiplier, rounded to a whole number.
function computePoints({ round, communityShare }) {
  return Math.round(BASE * roundMultiplier(round) * upsetMultiplier(communityShare));
}

// Coins are a separate reward currency derived from points.
function computeCoins(points) {
  return Math.round(points * COIN_RATE);
}

module.exports = { roundMultiplier, upsetMultiplier, computePoints, computeCoins };
