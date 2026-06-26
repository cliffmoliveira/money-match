// Auth-aware fetch for value-bearing API calls.
//
// The JWT saved at login (localStorage 'authToken') is attached as a Bearer
// header so the server can scope every request to the authenticated user. The
// server derives the userId from this verified token and ignores any userId in
// the body/query — so these helpers are the only thing the protected endpoints
// trust. Use them for anything that reads or mutates a user's wallet, bets, or
// account; plain fetch() is fine for public reads (markets, tournaments).

export function authHeader() {
  const token = localStorage.getItem('authToken');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Drop-in replacement for fetch() that merges in the Authorization header.
// Caller-supplied headers (e.g. Content-Type) are preserved.
export function apiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeader() },
  });
}
