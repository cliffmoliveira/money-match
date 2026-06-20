// Pick'em scoring config (spec §3). All tunable constants live here.
module.exports = {
  BASE: 100,
  COIN_RATE: 0.5, // coins = round(points * COIN_RATE)
  UPSET_CAP: 3.0, // max upset multiplier
  // Later rounds matter more (prevents early runaway leaders).
  ROUND_MULTIPLIERS: { r1: 1.0, r2: 1.25, r3: 1.5, top8: 1.75, top4: 2.0, gf: 3.0 },
  // Streak length -> one-time bonus coins awarded when the streak first reaches it.
  STREAK_MILESTONES: { 5: 50, 10: 150, 20: 500 },
};
