// Inclusive boundary: a postback at exactly created_at + windowDays is in-window;
// strictly beyond is expired. Computed from the stored created_at (never a ULID time).
function isWithinWindow(createdAtISO, receivedAtISO, windowDays) {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const elapsed = Date.parse(receivedAtISO) - Date.parse(createdAtISO);
  return elapsed <= windowMs; // <= = inclusive
}
module.exports = { isWithinWindow };
