const { test } = require('node:test');
const assert = require('node:assert');
const { isWithinWindow } = require('../../affiliate/window');

const DAY = 24 * 60 * 60 * 1000;
const created = '2026-06-01T00:00:00.000Z';
const at = (ms) => new Date(Date.parse(created) + ms).toISOString();

test('within window (1 day later, 30-day window)', () => {
  assert.strictEqual(isWithinWindow(created, at(1 * DAY), 30), true);
});
test('exact boundary is inclusive (exactly window end -> within)', () => {
  assert.strictEqual(isWithinWindow(created, at(30 * DAY), 30), true);
});
test('strictly beyond the boundary is expired', () => {
  assert.strictEqual(isWithinWindow(created, at(30 * DAY + 1), 30), false);
});
