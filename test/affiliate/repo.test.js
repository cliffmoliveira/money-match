const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { freshDb, cleanup } = require('./helpers');

let repo, file;
before(async () => { const f = await freshDb(); file = f.file; repo = require('../../affiliate/repo'); });
after(() => cleanup(file));

const baseClick = {
  click_id: 'CLK1', user_id: 6, region: 'BR', book: 'mock_book', affiliate_id: 'mm-mock-01',
  event_id: 'e1', match_id: 'm1', market_id: 'mk1', selection_id: 's1', participant_id: 'p1',
  source_page: 'live', deep_link_url: 'http://localhost:4100/bet?click_id=CLK1', created_at: '2026-06-01T00:00:00.000Z',
};

test('createClick then findClick round-trips and defaults status=clicked', async () => {
  await repo.createClick(baseClick);
  const row = await repo.findClick('CLK1');
  assert.strictEqual(row.status, 'clicked');
  assert.strictEqual(row.region, 'BR');
});

test('insertConversion succeeds once; a second with same (book,external_ref) throws UNIQUE', async () => {
  const conv = { conversion_id: 'CONV1', postback_log_id: 1, click_id: 'CLK1', book: 'mock_book',
    external_ref: 'X1', conversion_type: 'first_time_deposit', amount: 5000, currency: 'BRL',
    commission_model: 'cpa', commission_value: 12000, received_at: '2026-06-02T00:00:00.000Z' };
  await repo.insertConversion(conv);
  await assert.rejects(
    () => repo.insertConversion({ ...conv, conversion_id: 'CONV2' }),
    (err) => repo.isUniqueViolation(err)
  );
});

test('markClickConverted flips status; logPostback appends and returns id', async () => {
  await repo.markClickConverted('CLK1');
  assert.strictEqual((await repo.findClick('CLK1')).status, 'converted');
  const id = await repo.logPostback({ received_at: 'now', remote_ip: '::1', raw_payload: '{}' });
  assert.ok(Number.isInteger(id) && id > 0);
});

test('resolveConversion sets terminal status + resolved_at; earnedTotal sums validated only', async () => {
  await repo.resolveConversion('CONV1', 'validated', '2026-06-03T00:00:00.000Z');
  assert.strictEqual(await repo.earnedTotal(), 12000);
  await repo.resolveConversion('CONV1', 'rejected', '2026-06-04T00:00:00.000Z');
  assert.strictEqual(await repo.earnedTotal(), 0);
});
