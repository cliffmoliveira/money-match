// Single source of truth for the JWT signing/verification secret. server.js
// signs login tokens with this and the requireAuth middleware verifies them
// against it, so both MUST agree. Set a strong, random JWT_SECRET in
// production; the dev fallback keeps local/test flows working unchanged.
module.exports = {
  secretKey: process.env.JWT_SECRET || 'your_secret_key',
};
