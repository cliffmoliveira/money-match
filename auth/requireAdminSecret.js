// Gate for internal admin-only routes. There's no user-role system in this
// app (every account is an equal player) — a single shared secret set via
// ADMIN_SECRET in Render's env is the "admin login" for site-operator-only
// actions like entering exhibition matches.
module.exports = function requireAdminSecret(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.get('x-admin-secret') !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
