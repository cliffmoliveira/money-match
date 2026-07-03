// tournaments.date is ideally a full ISO timestamp carrying the real
// start.gg start hour (e.g. "2026-07-03T14:00:00.000Z"), but rows not yet
// re-synced since that field stopped being truncated may still be a bare
// "YYYY-MM-DD".
//
// The two need different parsing: `new Date("2026-06-26")` (no time part)
// is spec'd to parse as UTC midnight, which then rolls back to the previous
// calendar day once converted to a negative-UTC-offset local timezone (most
// of the US) for display — so a bare date must be parsed as LOCAL midnight
// instead by appending a time part. A full timestamp already carries its
// own real instant and must be passed through unchanged.
export function parseTournamentDate(date) {
  if (!date) return null;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const d = new Date(isDateOnly ? `${date}T00:00:00` : date);
  return isNaN(d.getTime()) ? null : d;
}
