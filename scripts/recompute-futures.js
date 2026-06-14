// Recompute futures win_probability + odds for existing entrants from their
// stored seed_num, using the current seed model. No network needed; fixes data
// synced under an older model (e.g. a broken zero-probability Field).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../db/db');
const { fieldProbabilities } = require('../liveOdds');
const FIELD_NAME = 'The Field';
(async () => {
  const groups = await db.allAsync(`SELECT DISTINCT tournament_id, game_id FROM players_games_tournaments WHERE seed_num IS NOT NULL`);
  const fieldPlayer = await db.getAsync('SELECT id FROM players WHERE name = ?', [FIELD_NAME]);
  let updated = 0, fieldsFixed = 0, fieldsRemoved = 0;
  for (const { tournament_id, game_id } of groups) {
    const rows = await db.allAsync(`SELECT player_id, seed_num FROM players_games_tournaments WHERE tournament_id=? AND game_id=? AND seed_num IS NOT NULL ORDER BY seed_num`, [tournament_id, game_id]);
    // Re-rank to 1..N (raw seed values may be provisional/huge) and price by rank.
    const { players: probs, field } = fieldProbabilities(rows.map((_, i) => i + 1));
    for (let i = 0; i < rows.length; i++) {
      await db.runAsync(`UPDATE players_games_tournaments SET seed_num=?, win_probability=?, live_odds=? WHERE tournament_id=? AND game_id=? AND player_id=? AND (is_winner IS NULL OR is_winner = 0)`, [i + 1, probs[i].prob, probs[i].odds, tournament_id, game_id, rows[i].player_id]);
      updated++;
    }
    if (!fieldPlayer) continue;
    const ef = await db.getAsync(`SELECT player_id FROM players_games_tournaments WHERE tournament_id=? AND game_id=? AND player_id=?`, [tournament_id, game_id, fieldPlayer.id]);
    if (field.prob > 0.005) {
      if (ef) await db.runAsync(`UPDATE players_games_tournaments SET seed_num=NULL, win_probability=?, live_odds=? WHERE tournament_id=? AND game_id=? AND player_id=? AND (is_winner IS NULL OR is_winner = 0)`, [field.prob, field.odds, tournament_id, game_id, fieldPlayer.id]);
      else await db.runAsync(`INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, seed_num, win_probability, live_odds, created_at) VALUES (?,?,?,NULL,?,?,CURRENT_TIMESTAMP)`, [tournament_id, game_id, fieldPlayer.id, field.prob, field.odds]);
      fieldsFixed++;
    } else if (ef) { await db.runAsync(`DELETE FROM players_games_tournaments WHERE tournament_id=? AND game_id=? AND player_id=?`, [tournament_id, game_id, fieldPlayer.id]); fieldsRemoved++; }
  }
  console.log(`recompute: ${updated} seeded rows updated, ${fieldsFixed} field rows fixed, ${fieldsRemoved} removed`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
