import { getUserTimezone } from './timezone';

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
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTournamentDate(date) {
  if (!date) return null;
  const isDateOnly = DATE_ONLY_RE.test(date);
  const d = new Date(isDateOnly ? `${date}T00:00:00` : date);
  return isNaN(d.getTime()) ? null : d;
}

// Formats a tournament date for display, in the viewer's chosen timezone.
// Bare "YYYY-MM-DD" rows — tournaments not yet re-synced with a real
// start.gg hour, or exhibitions which never carry a clock time at all —
// only ever show the date, since inventing a midnight time would be
// misleading.
export function formatTournamentDateTime(date, timezone = getUserTimezone()) {
  if (!date) return '';
  if (DATE_ONLY_RE.test(date)) {
    // No real instant here (parseTournamentDate anchors it to the browser's
    // OWN local midnight as an implementation detail, not a real moment) —
    // so it must never be run through a timeZone conversion, which could
    // roll it to the adjacent calendar day depending on the viewer's chosen
    // zone vs. their browser's locale. Read the Y/M/D straight off the
    // string instead and render it inert of any zone.
    const [y, m, day] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day))
      .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  const d = parseTournamentDate(date);
  if (!d) return '';
  const datePart = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: timezone });
  const timePart = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: timezone });
  return `${datePart}, ${timePart}`;
}
