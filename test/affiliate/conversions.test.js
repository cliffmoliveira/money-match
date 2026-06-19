const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const request = require('./request');
const { freshDb, cleanup, makeApp, resetTables } = require('./helpers');
const { sign } = require('../../affiliate/hmac');
const config = require('../../affiliate/config');

let app, file, repo, db;
before(async () => { const f = await freshDb(); file = f.file; db = f.db; repo = require('../../affiliate/repo'); app = makeApp(); });
beforeEach(async () => { await resetTables(db); });
after(() => cleanup(file));

// Seed one click + one pending conversion; returns its conversion_id.
async function seedConversion(externalRef = 'X1', commissionValue = 12000) {
  await repo.createClick({ click_id: 'CLK1', user_id: 6, region: 'BR', book: 'mock_book', affiliate_id: 'mm-mock-01',
    event_id: 'e1', match_id: 'm1', market_id: 'mk1', selection_id: 's1', participant_id: 'p1',
    source_page: 'live', deep_link_url: 'x', created_at: new Date().toISOString() });
  const body = JSON.stringify({ book: 'mock_book', click_id: 'CLK1', external_ref: externalRef,
    conversion_type: 'first_time_deposit', amount: 5000, currency: 'BRL', commission_model: 'cpa', commission_value: commissionValue });
  await request(app).post('/api/affiliate/postback').set('X-MM-Signature', sign(Buffer.from(body), config.hmacSecret))
    .set('Content-Type', 'application/json').send(body);
  return (await db.getAsync(`SELECT conversion_id FROM conversion_records WHERE external_ref = ?`, [externalRef])).conversion_id;
}

test('pending is not earned; validate -> validated (earned); resolved_at set', async () => {
  const id = await seedConversion();
  assert.strictEqual(await repo.earnedTotal(), 0);
  const res = await request(app).post(`/api/affiliate/conversions/${id}/validate`);
  assert.strictEqual(res.status, 200);
  const row = await db.getAsync(`SELECT * FROM conversion_records WHERE conversion_id = ?`, [id]);
  assert.strictEqual(row.validation_status, 'validated');
  assert.ok(row.resolved_at);
  assert.strictEqual(await repo.earnedTotal(), 12000);
});

test('reject -> rejected, not earned', async () => {
  const id = await seedConversion('X9', 7000);
  const res = await request(app).post(`/api/affiliate/conversions/${id}/reject`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await db.getAsync(`SELECT validation_status FROM conversion_records WHERE conversion_id = ?`, [id])).validation_status, 'rejected');
  assert.strictEqual(await repo.earnedTotal(), 0);
});
