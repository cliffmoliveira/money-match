const { test } = require('node:test');
const assert = require('node:assert');
const bookSign = require('../../mock-book/hmac');          // mock book's OWN sign
const { verify } = require('../../affiliate/hmac');         // Money Match's verify

test('mock-book signature verifies under Money Match with the same secret', () => {
  const secret = 'shared';
  const raw = Buffer.from(JSON.stringify({ book: 'mock_book', external_ref: 'X1' }));
  const sig = bookSign(raw, secret);
  assert.strictEqual(verify(raw, sig, secret), true);
});

test('a different secret does NOT verify', () => {
  const raw = Buffer.from('{}');
  assert.strictEqual(verify(raw, bookSign(raw, 'a'), 'b'), false);
});
