const crypto = require('crypto');

// HMAC-SHA256 of the exact raw bytes, hex-encoded.
function sign(rawBuffer, secret) {
  return crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex');
}

// Constant-time compare. Returns false (never throws) on any malformed input,
// including length mismatch (timingSafeEqual throws if lengths differ).
function verify(rawBuffer, signatureHex, secret) {
  if (typeof signatureHex !== 'string') return false;
  const expected = Buffer.from(sign(rawBuffer, secret), 'hex');
  let provided;
  try { provided = Buffer.from(signatureHex, 'hex'); } catch { return false; }
  if (provided.length !== expected.length || provided.length === 0) return false;
  return crypto.timingSafeEqual(provided, expected);
}

module.exports = { sign, verify };
