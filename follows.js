/**
 * Follow-a-competitor: track players already present in the ingested
 * start.gg entrant/set data (no arbitrary-name follow flow). Stats combine
 * the two sources of settled-set history in the schema: `matches` (older
 * grand-finals-only historical sync) and `set_markets` (current live +
 * backfilled Top 8 data, all rounds).
 */
const db = require('./db/db');

// The game + tournament a player most recently appeared in, so search results
// for near-duplicate names (sponsor-tag changes, doubles-team entrants) can be
// told apart without following each one to check. Null when nothing is tracked.
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

async function getPlayerRecord(playerId) {
  const row = await db.getAsync(
    `SELECT
       (SELECT COUNT(*) FROM matches WHERE winner_id = ?) +
       (SELECT COUNT(*) FROM set_markets WHERE state = 'settled' AND winner_id = ?)
         AS wins,
       (SELECT COUNT(*) FROM matches WHERE loser_id = ?) +
       (SELECT COUNT(*) FROM set_markets
          WHERE state = 'settled' AND winner_id IS NOT NULL AND winner_id != ?
            AND (player1_id = ? OR player2_id = ?))
         AS losses`,
    [playerId, playerId, playerId, playerId, playerId, playerId]
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

async function getTournamentHistory(playerId) {
  const rows = await db.allAsync(
    `SELECT t.id AS tournamentId, t.name AS tournamentName, t.date, t.logo_url AS logoUrl,
            g.id AS gameId, g.name AS gameName, pgt.placement AS placement
     FROM players_games_tournaments pgt
     JOIN tournaments t ON t.id = pgt.tournament_id
     JOIN games g ON g.id = pgt.game_id
     WHERE pgt.player_id = ?
     ORDER BY date(t.date) DESC`,
    [playerId]
  );
  return Promise.all(rows.map(async (r) => {
    // Exact placement wins whenever we have it — every entry then reads the
    // same way ("Champion" / "9th place") instead of mixing in round names.
    // Falls back to the Top 8 round-based result only for tournaments
    // sync-standings.js hasn't processed yet (or an in-progress bracket).
    let result;
    if (r.placement != null) {
      result = r.placement === 1 ? 'Champion' : `${ordinal(r.placement)} place`;
    } else {
      result = (await getTournamentResult(playerId, r.tournamentId, r.gameId)) || 'No result recorded';
    }
    return { ...r, result };
  }));
}

async function getPlayerProfile(playerId) {
  const player = await db.getAsync('SELECT id, name, country, photo_url AS photoUrl FROM players WHERE id = ?', [playerId]);
  if (!player) { const e = new Error('Player not found'); e.code = 'NOT_FOUND'; throw e; }
  const [record, tournaments] = await Promise.all([
    getPlayerRecord(playerId),
    getTournamentHistory(playerId),
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
    const [record, { c: tournamentCount }] = await Promise.all([
      getPlayerRecord(p.id),
      db.getAsync('SELECT COUNT(*) AS c FROM players_games_tournaments WHERE player_id = ?', [p.id]),
    ]);
    return { ...p, record, tournamentCount };
  }));
}

module.exports = {
  searchPlayers, followPlayer, unfollowPlayer, getPlayerProfile, getFollowedWithStats,
};
