const { test } = require('node:test');
const assert = require('node:assert');
const { sign, verify } = require('../../affiliate/hmac');

const SECRET = 'shared-secret';
const raw = Buffer.from(JSON.stringify({ a: 1, b: 'x' }));

test('verify accepts a signature produced by sign', () => {
  assert.strictEqual(verify(raw, sign(raw, SECRET), SECRET), true);
});
test('verify rejects a tampered body', () => {
  const sig = sign(raw, SECRET);
  assert.strictEqual(verify(Buffer.from(JSON.stringify({ a: 1, b: 'y' })), sig, SECRET), false);
});
test('verify rejects a wrong secret', () => {
  assert.strictEqual(verify(raw, sign(raw, SECRET), 'other-secret'), false);
});
test('verify returns false (no throw) on a missing/garbage signature', () => {
  assert.strictEqual(verify(raw, undefined, SECRET), false);
  assert.strictEqual(verify(raw, 'not-hex', SECRET), false);
});
