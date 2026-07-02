const db = require('./db/db');

async function applyExhibitionsSchema() {
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS exhibitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER REFERENCES tournaments(id),
      tournament_name TEXT,
      player1_name TEXT NOT NULL,
      player2_name TEXT NOT NULL,
      game_name TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      winner_name TEXT,
      winner_score INTEGER,
      loser_score INTEGER,
      notes TEXT,
      event_date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Add score columns to existing tables on Render (ALTER TABLE ignores if already present via try/catch)
  for (const col of ['winner_score INTEGER', 'loser_score INTEGER']) {
    try {
      await db.runAsync(`ALTER TABLE exhibitions ADD COLUMN ${col}`);
    } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }
  // Fix Ludwig/Tyler1 exhibition: Ludwig won 10-3
  await db.runAsync(`
    UPDATE exhibitions
    SET winner_name = 'Ludwig', winner_score = 10, loser_score = 3, state = 'settled'
    WHERE player1_name IN ('Ludwig','Tyler1') AND player2_name IN ('Ludwig','Tyler1')
      AND (winner_name IS NULL OR winner_name = 'Tyler1')
  `);
}

async function getActiveExhibitions() {
  return db.allAsync(`
    SELECT e.*, t.logo_url AS tournament_logo_url
    FROM exhibitions e
    LEFT JOIN tournaments t ON t.id = e.tournament_id
    WHERE e.state IN ('open', 'closed')
    ORDER BY e.created_at DESC
  `);
}

// Admin-only: every exhibition regardless of state (including 'pending' ones
// not yet opened), so the admin page can manage drafts the public endpoints
// deliberately exclude.
async function getAllExhibitions() {
  return db.allAsync(`
    SELECT e.*, t.logo_url AS tournament_logo_url
    FROM exhibitions e
    LEFT JOIN tournaments t ON t.id = e.tournament_id
    ORDER BY e.created_at DESC
  `);
}

async function getSettledExhibitions() {
  return db.allAsync(`
    SELECT e.*, t.logo_url AS tournament_logo_url, t.city, t.country
    FROM exhibitions e
    LEFT JOIN tournaments t ON t.id = e.tournament_id
    WHERE e.state = 'settled'
    ORDER BY COALESCE(e.event_date, e.created_at) DESC
  `);
}

async function createExhibition({ tournament_id, tournament_name, player1_name, player2_name, game_name, notes, event_date, state, winner_name }) {
  const result = await db.runAsync(
    `INSERT INTO exhibitions (tournament_id, tournament_name, player1_name, player2_name, game_name, notes, event_date, state, winner_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tournament_id || null, tournament_name || null, player1_name, player2_name, game_name || null, notes || null, event_date || null, state || 'pending', winner_name || null]
  );
  return result.lastID;
}

async function settleExhibition(id, winner_name, winner_score = null, loser_score = null) {
  await db.runAsync(
    `UPDATE exhibitions SET state = 'settled', winner_name = ?, winner_score = ?, loser_score = ? WHERE id = ?`,
    [winner_name, winner_score, loser_score, id]
  );
}

async function openExhibition(id) {
  await db.runAsync(`UPDATE exhibitions SET state = 'open' WHERE id = ?`, [id]);
}

async function closeExhibition(id) {
  await db.runAsync(`UPDATE exhibitions SET state = 'closed' WHERE id = ?`, [id]);
}

module.exports = {
  applyExhibitionsSchema,
  getActiveExhibitions,
  getAllExhibitions,
  getSettledExhibitions,
  createExhibition,
  settleExhibition,
  openExhibition,
  closeExhibition,
};
