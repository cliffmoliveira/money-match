const jwt = require('jsonwebtoken');
const { secretKey } = require('./secret');

// Auth gate for every value-bearing endpoint.
//
// Reads `Authorization: Bearer <token>`, verifies the JWT with the shared
// secretKey, and pins `req.userId` to the token's `id`. Handlers MUST scope
// their reads/writes to `req.userId` and never trust a userId from the request
// body or query — those are attacker-controlled.
//
// Defense in depth: legacy/forged callers may still send a `userId` in the
// body or query. We never use it for scoping, but if it's present AND doesn't
// match the authenticated user we reject with 403 so a mismatched/forged id
// fails loudly instead of silently touching someone else's data.
function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let payload;
  try {
    payload = jwt.verify(match[1], secretKey);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (!payload || payload.id == null) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.userId = Number(payload.id);

  const claimed = (req.body && req.body.userId) ?? (req.query && req.query.userId);
  if (claimed !== undefined && claimed !== null && claimed !== '' && Number(claimed) !== req.userId) {
    return res.status(403).json({ error: 'User mismatch' });
  }

  next();
}

module.exports = requireAuth;
