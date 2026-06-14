/**
 * Live per-set odds: a parimutuel pool seeded with a virtual "subsidy" stake
 * split by a seed-based opening probability. With no real money the line equals
 * the seed line; as real bets accumulate and outgrow the (capped) subsidy the
 * pool takes over. The subsidy SCALES with participation — see
 * effectiveSubsidyCents — so the house's exposure stays tiny on thin pools and
 * fades to nothing on deep ones. One mechanism, no special-casing.
 */
const RAKE = 0.05;            // house margin, matches existing futures pool
const SEED_K_CENTS = 20000;   // $200 — the subsidy CEILING (see effectiveSubsidyCents)
const WINNERS_SIDE_BUMP = 1.15; // bracket-position edge for the winners-side player

// The subsidy scales with participation instead of being a flat $200: it tracks
// a fraction of the live pool, floored just high enough to price the opening
// line and capped at SEED_K_CENTS. Effect — a thin pool carries tiny house
// exposure (the subsidy is small in absolute terms), and once the real pool is
// large the subsidy stops growing so its influence (and the house's risk) fades
// toward pure parimutuel.
const SUBSIDY_FLOOR_CENTS = 1000;   // $10 — enough to price the first bet
const SUBSIDY_POOL_FRACTION = 0.25; // subsidy tracks 25% of the live pool
function effectiveSubsidyCents(poolCents = 0) {
  return Math.max(SUBSIDY_FLOOR_CENTS, Math.min(SEED_K_CENTS, Math.round(SUBSIDY_POOL_FRACTION * poolCents)));
}

const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Opening win probabilities from seeds (lower seedNum = stronger). Optional
 * winners-side bump reflects that a player who hasn't lost yet is favored.
 */
function openingProbabilities(seed1, seed2, p1IsWinnersSide = false, p2IsWinnersSide = false) {
  const s1 = 1 / Math.max(1, Number(seed1) || 999);
  const s2 = 1 / Math.max(1, Number(seed2) || 999);
  const a1 = s1 * (p1IsWinnersSide ? WINNERS_SIDE_BUMP : 1);
  const a2 = s2 * (p2IsWinnersSide ? WINNERS_SIDE_BUMP : 1);
  const p1 = a1 / (a1 + a2);
  return { p1, p2: 1 - p1 };
}

/**
 * Decimal odds for each side from the real pools plus the virtual subsidy.
 */
function computeLiveOdds({ p1Prob, p2Prob, seedKCents = SEED_K_CENTS, p1PoolCents = 0, p2PoolCents = 0 }) {
  const virt1 = seedKCents * p1Prob;
  const virt2 = seedKCents * p2Prob;
  const eff1 = p1PoolCents + virt1;
  const eff2 = p2PoolCents + virt2;
  const total = eff1 + eff2;
  return {
    p1Odds: round2((total / eff1) * (1 - RAKE)),
    p2Odds: round2((total / eff2) * (1 - RAKE)),
  };
}

const FIELD_TAIL_CAP = 64; // how far down the seed list the "Field" tail reaches

// Clamp keeps a degenerate probability from producing absurd odds.
const oddsFromProb = (prob) => round2(Math.min((1 / Math.max(prob, 1e-6)) * (1 - RAKE), 999));

/**
 * N-way outright (win-the-event) probabilities from seeds, used for futures.
 * Each listed player's strength is 1/seed; the unlisted remainder is collapsed
 * into a single "Field" whose strength is the harmonic tail of the seeds just
 * past the listed ones, out to a fixed depth. We deliberately DON'T use the
 * event's entrant count — upcoming majors report partial/zero registration,
 * which would zero out the field and blow up its odds. Returns per-seed
 * probabilities + the Field probability, normalized to sum to ~1, with odds.
 */
function fieldProbabilities(seeds = []) {
  const listed = seeds.map((s) => ({ seed: s, strength: 1 / Math.max(1, Number(s) || 1) }));
  const lastSeed = Math.max(...seeds.map(Number), seeds.length);
  let fieldStrength = 0;
  for (let s = lastSeed + 1; s <= FIELD_TAIL_CAP; s++) fieldStrength += 1 / s;
  const Z = listed.reduce((a, p) => a + p.strength, 0) + fieldStrength;
  const players = listed.map((p) => {
    const prob = p.strength / Z;
    return { seed: p.seed, prob, odds: oddsFromProb(prob) };
  });
  const fieldProb = fieldStrength / Z;
  return { players, field: { prob: fieldProb, odds: oddsFromProb(fieldProb) } };
}

module.exports = {
  RAKE, SEED_K_CENTS, SUBSIDY_FLOOR_CENTS, SUBSIDY_POOL_FRACTION, effectiveSubsidyCents,
  openingProbabilities, computeLiveOdds, round2, oddsFromProb, fieldProbabilities,
};
