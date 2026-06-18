const { test } = require('node:test');
const assert = require('node:assert');
const { resolveRegion } = require('../../affiliate/region');

test('resolveRegion returns the configured dev region, server-side', () => {
  const req = { ip: '127.0.0.1', body: { region: 'US' } };
  assert.strictEqual(resolveRegion(req), process.env.AFFILIATE_DEV_REGION || 'BR');
});
