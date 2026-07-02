/**
 * Follow-a-competitor: track players already present in the ingested
 * start.gg entrant/set data (no arbitrary-name follow flow). Stats combine
 * the two sources of settled-set history in the schema: `matches` (older
 * grand-finals-only historical sync) and `set_markets` (current live +
 * backfilled Top 8 data, all rounds).
 */
const db = require('./db/db');

async function searchPlayers(query, limit = 20) {
  const q = (query || '').trim();
  if (!q) return [];
  return db.allAsync(
    `SELECT id, name, country, photo_url AS photoUrl FROM players WHERE name LIKE ? ORDER BY name LIMIT ?`,
    [`%${q}%`, limit]
  );
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

async function getChampionships(playerId) {
  return db.allAsync(
    `SELECT t.id AS tournamentId, t.name AS tournamentName, t.date, t.logo_url AS logoUrl,
            g.name AS gameName
     FROM players_games_tournaments pgt
     JOIN tournaments t ON t.id = pgt.tournament_id
     JOIN games g ON g.id = pgt.game_id
     WHERE pgt.player_id = ? AND pgt.is_winner = 1
     ORDER BY date(t.date) DESC`,
    [playerId]
  );
}

async function getTournamentHistory(playerId) {
  return db.allAsync(
    `SELECT t.id AS tournamentId, t.name AS tournamentName, t.date, t.logo_url AS logoUrl,
            g.name AS gameName, pgt.seed_num AS seedNum, pgt.is_winner AS isWinner
     FROM players_games_tournaments pgt
     JOIN tournaments t ON t.id = pgt.tournament_id
     JOIN games g ON g.id = pgt.game_id
     WHERE pgt.player_id = ?
     ORDER BY date(t.date) DESC`,
    [playerId]
  );
}

async function getPlayerProfile(playerId) {
  const player = await db.getAsync('SELECT id, name, country, photo_url AS photoUrl FROM players WHERE id = ?', [playerId]);
  if (!player) { const e = new Error('Player not found'); e.code = 'NOT_FOUND'; throw e; }
  const [record, championships, tournaments] = await Promise.all([
    getPlayerRecord(playerId),
    getChampionships(playerId),
    getTournamentHistory(playerId),
  ]);
  return { player, record, championships, tournaments };
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
    const [record, championships] = await Promise.all([
      getPlayerRecord(p.id),
      getChampionships(p.id),
    ]);
    return { ...p, record, championshipCount: championships.length };
  }));
}

module.exports = {
  searchPlayers, followPlayer, unfollowPlayer, getPlayerProfile, getFollowedWithStats,
};
