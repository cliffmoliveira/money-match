const db = require('./db/db');

// Futures markets close when a tournament starts. A tournament is treated as
// "started" — and its futures book locked — once today is on or after its
// calendar date, so a tournament is treated as "started" for the whole day
// it begins regardless of its exact kickoff hour. Tournament dates now store
// a full start.gg timestamp (e.g. "2026-07-05T15:00:00.000Z"), not a bare
// date, so both sides must be truncated with date() before comparing -
// otherwise the raw string "2026-07-05T15:00:00.000Z" sorts *after* the bare
// "2026-07-05" (it's a longer string sharing the same prefix), and the
// comparison silently reads as "not yet started" all day even once the
// bracket is live. This is the single source of truth the bet route uses to
// reject picks (new or edited) on an event that is already underway; the
// Live (parimutuel) book handles in-progress play.
async function isFuturesLocked(tournamentId) {
  const row = await db.getAsync(
    `SELECT (date(date) <= date('now')) AS locked FROM tournaments WHERE id = ?`,
    [tournamentId]
  );
  if (!row) return { found: false, locked: false };
  return { found: true, locked: !!row.locked };
}

module.exports = { isFuturesLocked };
