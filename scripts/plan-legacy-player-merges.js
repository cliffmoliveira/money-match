/**
 * Phase 1 (read-only) of the legacy-duplicate-player cleanup.
 *
 * Finds every "legacy" player row (id < 200, from the original bare-name
 * Grand-Finals-only matches backfill, e.g. "MenaRD", "Tokido") that has a
 * name-substring candidate among the "modern" (id >= 200, synced from
 * Start.gg with real tournament tracking) rows, then VERIFIES each modern
 * candidate against the live Start.gg API by resolving its real, stable
 * Participant.player.id (see scripts/lib/players.js) — rather than trusting
 * the name-substring match alone, which is how the MenaRD bug's siblings
 * (Tokido, MkLeo, etc.) were found in the first place: some of them have
 * MULTIPLE modern rows from sponsor changes, and a couple of legacy names
 * are common enough that a naive merge risks conflating two different real
 * people.
 *
 * Decision logic per legacy-name cluster:
 *   - Any 2+ modern candidates that resolve to the SAME real player.id are
 *     the same person (sponsor changed) -> merge them together regardless.
 *   - If that collapses the cluster to exactly one remaining real identity,
 *     attach the legacy row to it too (no more ambiguity about who the bare
 *     name refers to).
 *   - If 2+ DISTINCT real identities remain after merging exact matches,
 *     leave the legacy row unattached and flag the cluster AMBIguous for
 *     manual review — a substring match is not enough to guess which one
 *     the legacy name means.
 *
 * Writes a plan to scripts/.legacy-merge-plan.json (git-ignored, matching
 * the .backfill-state.json convention) for phase 2
 * (apply-legacy-player-merges.js) to execute. Nothing here writes to the
 * database.
 *
 * Usage:
 *   node scripts/plan-legacy-player-merges.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db/db');
const { startgg } = require('../startggClient');

const PLAN_FILE = path.join(__dirname, '.legacy-merge-plan.json');
const REQ_DELAY_MS = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirrors client/src/utils/playerName.js's splitPlayerName exactly: a name
// with no "|" and a "/" whose left segment isn't Japanese/CJK is a 2v2 team
// pairing ("Player1 / Player2"), not a sponsor+tag. See the exclusion
// comment below for why these are never merge candidates.
const hasJapanese = (s) => /[぀-ヿ一-鿿＀-￯]/.test(s);
function isTeamPairing(name) {
  if (!name || name.includes('|')) return false;
  const si = name.indexOf('/');
  return si !== -1 && !hasJapanese(name.slice(0, si));
}

async function ggRetry(query, vars) {
  for (let attempt = 1; ; attempt++) {
    try {
      const data = await startgg(query, vars);
      await sleep(REQ_DELAY_MS);
      return data;
    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || (!err.response && !!err.request);
      if (!retryable || attempt >= 5) throw err;
      const backoff = Math.min(30000, 2000 * 2 ** attempt);
      console.warn(`  start.gg ${status}; retrying in ${backoff / 1000}s (attempt ${attempt}/5)`);
      await sleep(backoff);
    }
  }
}

// One tournament this modern candidate is actually linked to, so we can ask
// Start.gg "who is this, really" via that tournament's real entrant data.
async function oneTournamentFor(playerId) {
  const row = await db.getAsync(
    `SELECT t.startgg_id AS tsid FROM players_games_tournaments pgt
     JOIN tournaments t ON t.id = pgt.tournament_id
     WHERE pgt.player_id = ? AND t.startgg_id IS NOT NULL LIMIT 1`,
    [playerId]
  );
  if (row?.tsid) return row.tsid;
  const row2 = await db.getAsync(
    `SELECT t.startgg_id AS tsid FROM set_markets sm
     JOIN tournaments t ON t.id = sm.tournament_id
     WHERE (sm.player1_id = ? OR sm.player2_id = ?) AND t.startgg_id IS NOT NULL LIMIT 1`,
    [playerId, playerId]
  );
  return row2?.tsid ?? null;
}

const ENTRANT_BY_NAME = `
  query($tid: ID!, $name: String!) {
    tournament(id: $tid) {
      events {
        id
        entrants(query: { perPage: 4, filter: { name: $name } }) {
          nodes { id name participants { player { id } } }
        }
      }
    }
  }`;

// Resolve a candidate's real, stable player.id: find a tournament they're
// linked to, ask Start.gg for that tournament's entrants matching their
// exact stored name, and read participants[].player.id off the match.
async function resolvePlayerId(name, tournamentStartggId) {
  if (!tournamentStartggId) return { ok: false, reason: 'no linked tournament with a real startgg_id' };
  let data;
  try {
    data = await ggRetry(ENTRANT_BY_NAME, { tid: tournamentStartggId, name });
  } catch (err) {
    return { ok: false, reason: `API error: ${err.message}` };
  }
  const events = data?.tournament?.events || [];
  for (const ev of events) {
    const hit = (ev.entrants?.nodes || []).find((e) => e.name === name);
    const pid = hit?.participants?.[0]?.player?.id;
    if (pid != null) return { ok: true, playerId: pid };
  }
  return { ok: false, reason: 'no matching entrant found in that tournament' };
}

async function activityOf(playerId) {
  const pgt = (await db.getAsync('SELECT COUNT(*) c FROM players_games_tournaments WHERE player_id=?', [playerId])).c;
  const sm = (await db.getAsync('SELECT COUNT(*) c FROM set_markets WHERE player1_id=? OR player2_id=?', [playerId, playerId])).c;
  const mt = (await db.getAsync('SELECT COUNT(*) c FROM matches WHERE winner_id=? OR loser_id=?', [playerId, playerId])).c;
  return { pgt, sm, mt, total: pgt + sm + mt };
}

async function main() {
  const legacyRows = await db.allAsync('SELECT id, name FROM players WHERE id < 200');
  const clusters = [];
  for (const legacy of legacyRows) {
    const candidates = await db.allAsync(
      `SELECT id, name FROM players
       WHERE id != ? AND id >= 200
         AND (name = ? OR name LIKE '%| ' || ? OR name LIKE '%|' || ? OR name LIKE ? || ' %' OR name LIKE '%/ ' || ? OR name LIKE '%丨' || ?)`,
      [legacy.id, legacy.name, legacy.name, legacy.name, legacy.name, legacy.name, legacy.name]
    );
    const withActivity = [];
    for (const c of candidates) {
      // Team-pairing entrants (e.g. "Sparg0 / ΩRugal", "MKBigBoss / MkLeo")
      // have 2+ Start.gg participants, so `participants[0].player.id`
      // resolves to WHICHEVER teammate the API happens to list first — not
      // reliably either one (confirmed: "Sparg0 / ΩRugal" and "Sparg0 /
      // Chag" resolved to two DIFFERENT real player.ids). Worse, per this
      // app's own splitPlayerName convention (client/src/utils/playerName.js)
      // a non-Japanese "/" pairing is tracked as its own distinct doubles
      // entity, separate from either teammate's solo record (exactly like
      // "SonicFox" vs "SonicFox / INZEM" are two intentionally separate
      // Follow entries) — so even a *correct* resolution would still be the
      // wrong thing to merge into a solo legacy row. Exclude these from the
      // candidate pool entirely rather than trying to resolve them.
      if (isTeamPairing(c.name)) continue;
      const act = await activityOf(c.id);
      if (act.total > 0) withActivity.push({ id: c.id, name: c.name, ...act });
    }
    if (withActivity.length) clusters.push({ legacy, candidates: withActivity });
  }

  console.log(`${clusters.length} legacy row(s) have at least one modern candidate with real activity.`);
  console.log(`Resolving each candidate's real player.id against Start.gg (rate-limited, ~${REQ_DELAY_MS}ms/call)...`);

  const plan = [];
  let n = 0, total = clusters.reduce((s, c) => s + c.candidates.length, 0);
  for (const cluster of clusters) {
    const resolved = [];
    for (const cand of cluster.candidates) {
      n++;
      const tsid = await oneTournamentFor(cand.id);
      const res = await resolvePlayerId(cand.name, tsid);
      resolved.push({ ...cand, resolution: res });
      process.stdout.write(`  [${n}/${total}] ${cluster.legacy.name} candidate "${cand.name}" (id ${cand.id}) -> ${res.ok ? `player.id ${res.playerId}` : `UNRESOLVED (${res.reason})`}\n`);
    }

    // Group resolved candidates by real player.id.
    const byPlayerId = new Map();
    const unresolved = [];
    for (const r of resolved) {
      if (r.resolution.ok) {
        const key = r.resolution.playerId;
        if (!byPlayerId.has(key)) byPlayerId.set(key, []);
        byPlayerId.get(key).push(r);
      } else {
        unresolved.push(r);
      }
    }
    const groups = [...byPlayerId.entries()].map(([playerId, rows]) => ({ playerId, rows }));

    if (groups.length === 1 && unresolved.length === 0) {
      // Exactly one verified real identity -> merge everything (legacy +
      // all modern rows in the group) into whichever row has the most
      // activity.
      const rows = groups[0].rows.sort((a, b) => b.total - a.total);
      const survivor = rows[0];
      const absorbed = rows.slice(1).map((r) => r.id);
      plan.push({
        legacyId: cluster.legacy.id, legacyName: cluster.legacy.name,
        verifiedPlayerId: groups[0].playerId,
        survivorId: survivor.id, survivorName: survivor.name,
        mergeIds: [cluster.legacy.id, ...absorbed],
        status: 'ready',
      });
    } else if (groups.length >= 1) {
      // Multiple distinct real identities (or some unresolved) sharing a
      // similar name — merge same-identity duplicates within the cluster
      // (still unambiguous), but don't guess which one the bare legacy
      // name means.
      const subMerges = groups
        .filter((g) => g.rows.length > 1)
        .map((g) => {
          const rows = g.rows.sort((a, b) => b.total - a.total);
          return { verifiedPlayerId: g.playerId, survivorId: rows[0].id, survivorName: rows[0].name, mergeIds: rows.map((r) => r.id) };
        });
      plan.push({
        legacyId: cluster.legacy.id, legacyName: cluster.legacy.name,
        status: 'ambiguous',
        reason: `${groups.length} distinct real identities and/or unresolved candidate(s) among: ${resolved.map((r) => `${r.name}(${r.id})${r.resolution.ok ? '=player' + r.resolution.playerId : '=unresolved'}`).join(', ')}`,
        subMerges, // still worth applying — collapses proven same-identity dupes even though the legacy row itself is left alone
      });
    } else {
      plan.push({
        legacyId: cluster.legacy.id, legacyName: cluster.legacy.name,
        status: 'unresolved',
        reason: 'no candidate could be verified against Start.gg',
      });
    }
  }

  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
  const ready = plan.filter((p) => p.status === 'ready').length;
  const ambiguous = plan.filter((p) => p.status === 'ambiguous').length;
  const unresolved = plan.filter((p) => p.status === 'unresolved').length;
  console.log(`\nPlan written to ${PLAN_FILE}`);
  console.log(`  ready to merge:      ${ready}`);
  console.log(`  ambiguous (skipped): ${ambiguous}`);
  console.log(`  unresolved (skipped):${unresolved}`);
  if (ambiguous) {
    console.log('\nAmbiguous clusters (legacy row left alone; review manually):');
    for (const p of plan.filter((x) => x.status === 'ambiguous')) {
      console.log(`  - ${p.legacyName} (id ${p.legacyId}): ${p.reason}`);
    }
  }
  await db.closeAsync();
}

main().catch((err) => {
  console.error('Planning failed:', err);
  process.exit(1);
});
