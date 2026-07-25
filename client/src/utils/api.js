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
//
// Also catches a rejected/expired token: if we believed we were logged in
// (a token was actually sent) and the server comes back 401, the token is no
// longer valid — clear it and bounce to a clean re-login instead of leaving
// the UI stuck showing a "logged in" state where every read/write silently
// 401s until the user notices and manually logs out. A 401 with NO token
// sent is left alone — that's just an anonymous visitor on a page that also
// happens to fetch user-scoped data (e.g. Home), not an expired session.
export async function apiFetch(url, options = {}) {
  const sentAuth = Boolean(localStorage.getItem('authToken'));
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), ...authHeader() },
  });
  if (res.status === 401 && sentAuth) {
    localStorage.removeItem('authToken');
    localStorage.removeItem('userId');
    localStorage.removeItem('username');
    if (!window.location.pathname.startsWith('/login')) {
      window.location.assign('/login?expired=1');
    }
  }
  return res;
}
