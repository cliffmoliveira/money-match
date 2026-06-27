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
      notes TEXT,
      event_date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
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

async function getSettledExhibitions() {
  return db.allAsync(`
    SELECT e.*, t.logo_url AS tournament_logo_url
    FROM exhibitions e
    LEFT JOIN tournaments t ON t.id = e.tournament_id
    WHERE e.state = 'settled'
    ORDER BY COALESCE(e.event_date, e.created_at) DESC
  `);
}

async function createExhibition({ tournament_id, tournament_name, player1_name, player2_name, game_name, notes, event_date, state }) {
  const result = await db.runAsync(
    `INSERT INTO exhibitions (tournament_id, tournament_name, player1_name, player2_name, game_name, notes, event_date, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [tournament_id || null, tournament_name || null, player1_name, player2_name, game_name || null, notes || null, event_date || null, state || 'pending']
  );
  return result.lastID;
}

async function settleExhibition(id, winner_name) {
  await db.runAsync(
    `UPDATE exhibitions SET state = 'settled', winner_name = ? WHERE id = ?`,
    [winner_name, id]
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
  getSettledExhibitions,
  createExhibition,
  settleExhibition,
  openExhibition,
  closeExhibition,
};
