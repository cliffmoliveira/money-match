const db = require('./db/db');

// Futures markets close when a tournament starts. Tournament dates are stored at
// day granularity (YYYY-MM-DD), so a tournament is treated as "started" — and its
// futures book locked — once today is on or after its date. This is the single
// source of truth the bet route uses to reject picks (new or edited) on an event
// that is already underway; the Live (parimutuel) book handles in-progress play.
async function isFuturesLocked(tournamentId) {
  const row = await db.getAsync(
    `SELECT (date <= DATE('now')) AS locked FROM tournaments WHERE id = ?`,
    [tournamentId]
  );
  if (!row) return { found: false, locked: false };
  return { found: true, locked: !!row.locked };
}

module.exports = { isFuturesLocked };
