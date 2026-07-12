/**
 * Follow-a-competitor: track players already present in the ingested
 * start.gg entrant/set data (no arbitrary-name follow flow). Stats combine
 * the two sources of settled-set history in the schema: `matches` (older
 * grand-finals-only historical sync) and `set_markets` (current live +
 * backfilled Top 8 data, all rounds).
 *
 * A followed SOLO player's record/history also folds in every 2v2 doubles
 * entrant they're part of (e.g. following "MkLeo" also counts his runs as
 * "MkLeo / MKBigBoss"). Doubles pairings are tracked as their own distinct
 * player rows (see playerName.js's isTeamPairing / scripts/lib/players.js's
 * doc comment for why — there's no single stable identity to fold a team
 * INTO a solo row), so without this a follower would only ever see a
 * player's singles results and silently miss every doubles run.
 */
const db = require('./db/db');
const { splitPlayerName, isTeamPairing } = require('./playerName');

// The game + tournament a player most recently appeared in, so search results
// for near-duplicate names (sponsor-tag changes, doubles-team entrants) can be
// told apart without following each one to check. Null when nothing is tracked.
// Deliberately solo-only (not expanded to teammates like the functions
// below) — this powers search disambiguation, where blending in doubles
// activity would blur the very distinction a searcher needs.
async function getLatestActivity(playerId) {
  const row = await db.getAsync(
    `SELECT t.name AS tournamentName, g.name AS gameName
     FROM players_games_tournaments pgt
     JOIN tournaments t ON t.id = pgt.tournament_id
     JOIN games g ON g.id = pgt.game_id
     WHERE pgt.player_id = ?
     ORDER BY date(t.date) DESC
     LIMIT 1`,
    [playerId]
  );
  return row ? `${row.gameName} · ${row.tournamentName}` : null;
}

async function searchPlayers(query, limit = 20) {
  const q = (query || '').trim();
  if (!q) return [];
  const rows = await db.allAsync(
    `SELECT id, name, country, photo_url AS photoUrl FROM players WHERE name LIKE ? ORDER BY name LIMIT ?`,
    [`%${q}%`, limit]
  );
  return Promise.all(rows.map(async (p) => ({ ...p, latestActivity: await getLatestActivity(p.id) })));
}

// Every 2v2 doubles-team row this (solo) player is part of, keyed by an
// exact case-insensitive tag match against one half of the team-pairing
// name — e.g. player "LG CS3 VARS | MkLeo" (tag "MkLeo") matches team rows
// "MkLeo / MKBigBoss" and "Tweek / MkLeo". `name LIKE '%/%'` is a rough SQL
// prefilter (can't use an index on a leading wildcard, but the players table
// is small enough that a full scan here — run on-demand per profile view,
// never on a hot/polled path — is not a concern); isTeamPairing + the exact
// tag match do the real filtering in JS.
async function teammateRowsOf(playerId, playerName) {
  const { tag } = splitPlayerName(playerName);
  const targetTag = (tag || playerName || '').trim().toLowerCase();
  if (!targetTag) return [];
  const candidates = await db.allAsync(`SELECT id, name FROM players WHERE id != ? AND name LIKE '%/%'`, [playerId]);
  return candidates
    .filter((c) => isTeamPairing(c.name))
    .map((c) => {
      const parts = c.name.split('/').map((s) => s.trim());
      const idx = parts.findIndex((p) => p.toLowerCase() === targetTag);
      if (idx === -1) return null;
      return { id: c.id, name: c.name, partner: parts.length === 2 ? parts[1 - idx] : null };
    })
    .filter(Boolean);
}

async function getPlayerRecord(ids) {
  const ph = ids.map(() => '?').join(',');
  const row = await db.getAsync(
    `SELECT
       (SELECT COUNT(*) FROM matches WHERE winner_id IN (${ph})) +
       (SELECT COUNT(*) FROM set_markets WHERE state = 'settled' AND winner_id IN (${ph}))
         AS wins,
       (SELECT COUNT(*) FROM matches WHERE loser_id IN (${ph})) +
       (SELECT COUNT(*) FROM set_markets
          WHERE state = 'settled' AND winner_id IS NOT NULL AND winner_id NOT IN (${ph})
            AND (player1_id IN (${ph}) OR player2_id IN (${ph})))
         AS losses`,
    [...ids, ...ids, ...ids, ...ids, ...ids, ...ids]
  );
  return { wins: row.wins || 0, losses: row.losses || 0 };
}

// Deepest-first Top 8 (and adjacent) round names, used to pick a player's
// most-advanced recorded set within ONE tournament/game. Text-based rather
// than start.gg's numeric `round` field, which is only relative within a
// single bracket — the same round name can carry a different round_int in
// every tournament depending on how many earlier rounds fed into it.
const ROUND_DEPTH = [
  'grand final reset', 'grand final',
  'losers final',
  'winners final', 'losers semi-final',
  'losers quarter-final',
  'winners semi-final', 'losers round 2',
  'winners quarter-final', 'losers round 1',
  'winners round 1',
];
const depthOf = (roundText) => {
  const i = ROUND_DEPTH.indexOf((roundText || '').toLowerCase().trim());
  return i === -1 ? ROUND_DEPTH.length : i;
};

// "How far they made it" in one tournament/game, derived from Top 8 bracket
// sets. Used ONLY as a fallback when scripts/sync-standings.js hasn't pulled
// an exact placement for this tournament yet (see getTournamentHistory) —
// once it has, the numeric placement is authoritative AND reads consistently
// ("9th place") instead of a round name, so it always wins when present.
// Returns null when no Top 8 set data exists for them here either (nothing
// to fall back to).
async function getTournamentResult(playerId, tournamentId, gameId) {
  const sets = await db.allAsync(
    `SELECT round_text, state, winner_id FROM set_markets
     WHERE tournament_id = ? AND game_id = ? AND (player1_id = ? OR player2_id = ?)
       AND round_text IS NOT NULL`,
    [tournamentId, gameId, playerId, playerId]
  );
  if (!sets.length) return null;

  const byDepth = (a, b) => depthOf(a.round_text) - depthOf(b.round_text);
  const deepestSettled = sets.filter((s) => s.state === 'settled').sort(byDepth)[0];
  if (deepestSettled) {
    const won = deepestSettled.winner_id === playerId;
    const isGrandFinal = /grand final/.test((deepestSettled.round_text || '').toLowerCase());
    if (won && isGrandFinal) return 'Champion';
    return won ? `Won ${deepestSettled.round_text}` : `Eliminated — ${deepestSettled.round_text}`;
  }
  const inProgress = sets.filter((s) => s.state === 'open' || s.state === 'closed').sort(byDepth)[0];
  return inProgress ? `Currently in ${inProgress.round_text}` : null;
}

// 1 -> "1st", 9 -> "9th", 33 -> "33rd", etc.
function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

// `sources` is [{ id, partner }] — the followed player themself (partner:
// null) plus every teammateRowsOf() doubles row. A player can legitimately
// have BOTH a singles and a doubles result for the same tournament+game (a
// major with both brackets), so this returns one entry per source row
// rather than deduping by tournament+game — the frontend labels each with
// its partner (or lack of one) to tell them apart.
async function getTournamentHistory(sources) {
  const results = [];
  for (const { id, partner } of sources) {
    const rows = await db.allAsync(
      `SELECT t.id AS tournamentId, t.name AS tournamentName, t.date, t.logo_url AS logoUrl,
              g.id AS gameId, g.name AS gameName, pgt.placement AS placement
       FROM players_games_tournaments pgt
       JOIN tournaments t ON t.id = pgt.tournament_id
       JOIN games g ON g.id = pgt.game_id
       WHERE pgt.player_id = ?
       ORDER BY date(t.date) DESC`,
      [id]
    );
    for (const r of rows) {
      // Exact placement wins whenever we have it — every entry then reads the
      // same way ("Champion" / "9th place") instead of mixing in round names.
      // Falls back to the Top 8 round-based result only for tournaments
      // sync-standings.js hasn't processed yet (or an in-progress bracket).
      let result;
      if (r.placement != null) {
        result = r.placement === 1 ? 'Champion' : `${ordinal(r.placement)} place`;
      } else {
        result = (await getTournamentResult(id, r.tournamentId, r.gameId)) || 'No result recorded';
      }
      results.push({ ...r, result, partner: partner || null });
    }
  }
  results.sort((a, b) => new Date(b.date) - new Date(a.date));
  return results;
}

async function getPlayerProfile(playerId) {
  const player = await db.getAsync('SELECT id, name, country, photo_url AS photoUrl FROM players WHERE id = ?', [playerId]);
  if (!player) { const e = new Error('Player not found'); e.code = 'NOT_FOUND'; throw e; }
  const teammates = await teammateRowsOf(playerId, player.name);
  const allIds = [playerId, ...teammates.map((t) => t.id)];
  const sources = [{ id: playerId, partner: null }, ...teammates.map((t) => ({ id: t.id, partner: t.partner }))];
  const [record, tournaments] = await Promise.all([
    getPlayerRecord(allIds),
    getTournamentHistory(sources),
  ]);
  return { player, record, tournaments };
}

async function followPlayer(userId, playerId) {
  const player = await db.getAsync('SELECT id FROM players WHERE id = ?', [playerId]);
  if (!player) { const e = new Error('Player not found'); e.code = 'NOT_FOUND'; throw e; }
  await db.runAsync(`INSERT OR IGNORE INTO follows (user_id, player_id) VALUES (?, ?)`, [userId, playerId]);
}

async function unfollowPlayer(userId, playerId) {
  await db.runAsync(`DELETE FROM follows WHERE user_id = ? AND player_id = ?`, [userId, playerId]);
}

async function getFollowedWithStats(userId) {
  const players = await db.allAsync(
    `SELECT p.id, p.name, p.country, p.photo_url AS photoUrl, f.created_at AS followedAt
     FROM follows f JOIN players p ON p.id = f.player_id
     WHERE f.user_id = ? ORDER BY f.created_at DESC`,
    [userId]
  );
  return Promise.all(players.map(async (p) => {
    const teammates = await teammateRowsOf(p.id, p.name);
    const allIds = [p.id, ...teammates.map((t) => t.id)];
    const ph = allIds.map(() => '?').join(',');
    const [record, { c: tournamentCount }] = await Promise.all([
      getPlayerRecord(allIds),
      db.getAsync(`SELECT COUNT(*) AS c FROM players_games_tournaments WHERE player_id IN (${ph})`, allIds),
    ]);
    return { ...p, record, tournamentCount };
  }));
}

module.exports = {
  searchPlayers, followPlayer, unfollowPlayer, getPlayerProfile, getFollowedWithStats,
};
