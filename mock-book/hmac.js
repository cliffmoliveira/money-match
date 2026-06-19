const crypto = require('crypto');
// The mock book's own signer. Intentionally a separate file from affiliate/hmac.js:
// in production the book holds its own copy of the shared secret and signing code.
module.exports = function sign(rawBuffer, secret) {
  return crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex');
};
