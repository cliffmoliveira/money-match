const { test } = require('node:test');
const assert = require('node:assert');
const { newId } = require('../../affiliate/ids');

test('newId returns a 26-char ULID', () => {
  const id = newId();
  assert.strictEqual(typeof id, 'string');
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('newId is unique across calls', () => {
  assert.notStrictEqual(newId(), newId());
});
