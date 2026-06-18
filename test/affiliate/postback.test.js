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

async function makeClick(clickId, createdAt = new Date().toISOString()) {
  await repo.createClick({ click_id: clickId, user_id: 6, region: 'BR', book: 'mock_book',
    affiliate_id: 'mm-mock-01', event_id: 'e1', match_id: 'm1', market_id: 'mk1', selection_id: 's1',
    participant_id: 'p1', source_page: 'live', deep_link_url: 'x', created_at: createdAt });
}
function payload(over = {}) {
  return JSON.stringify({ book: 'mock_book', click_id: 'CLK1', external_ref: 'X1',
    conversion_type: 'first_time_deposit', amount: 5000, currency: 'BRL',
    commission_model: 'cpa', commission_value: 12000, ...over });
}
function signed(body, secret = config.hmacSecret) {
  return { body, sig: sign(Buffer.from(body), secret) };
}
const post = (app, body, sig) => request(app).post('/api/affiliate/postback')
  .set('Content-Type', 'application/json').set('X-MM-Signature', sig || '').send(body);

test('valid + matched -> 200, conversion pending, click converted, log reconciled', async () => {
  await makeClick('CLK1');
  const { body, sig } = signed(payload());
  const res = await post(app, body, sig);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { received: true });
  assert.strictEqual((await repo.findClick('CLK1')).status, 'converted');
  const conv = await db.getAsync(`SELECT * FROM conversion_records WHERE click_id='CLK1'`);
  assert.strictEqual(conv.validation_status, 'pending');
  const log = await db.getAsync(`SELECT * FROM postback_log ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(log.outcome, 'reconciled');
  assert.strictEqual(log.signature_valid, 1);
});

test('invalid signature -> 401, logged rejected_signature, no conversion, no click change', async () => {
  await makeClick('CLK1');
  const res = await post(app, payload(), 'deadbeef');
  assert.strictEqual(res.status, 401);
  assert.strictEqual((await repo.findClick('CLK1')).status, 'clicked');
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM conversion_records`)).c, 0);
  const log = await db.getAsync(`SELECT * FROM postback_log ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(log.outcome, 'rejected_signature');
  assert.strictEqual(log.signature_valid, 0);
});

test('raw persisted before verify - a forged payload still appears in postback_log', async () => {
  const res = await post(app, payload(), 'deadbeef');
  assert.strictEqual(res.status, 401);
  const log = await db.getAsync(`SELECT * FROM postback_log ORDER BY id DESC LIMIT 1`);
  assert.ok(log.raw_payload.includes('first_time_deposit'));
});

test('PRECEDENCE: invalid signature AND malformed body -> 401 (gate before parse)', async () => {
  const res = await post(app, '{bad json', 'deadbeef');
  assert.strictEqual(res.status, 401);
});

test('valid signature + malformed body -> 400, logged malformed, no conversion', async () => {
  const body = '{not valid json';
  const sig = sign(Buffer.from(body), config.hmacSecret);
  const res = await post(app, body, sig);
  assert.strictEqual(res.status, 400);
  const log = await db.getAsync(`SELECT * FROM postback_log ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(log.outcome, 'malformed');
});

test('unknown click_id -> 200, logged unmatched, no conversion', async () => {
  const { body, sig } = signed(payload({ click_id: 'NOPE' }));
  const res = await post(app, body, sig);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await db.getAsync(`SELECT outcome FROM postback_log ORDER BY id DESC LIMIT 1`)).outcome, 'unmatched');
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM conversion_records`)).c, 0);
});

test('expired click_id -> 200, logged expired, no conversion', async () => {
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  await makeClick('CLK1', old);
  const { body, sig } = signed(payload());
  const res = await post(app, body, sig);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await db.getAsync(`SELECT outcome FROM postback_log ORDER BY id DESC LIMIT 1`)).outcome, 'expired');
});

test('duplicate (book,external_ref) -> idempotent 200, ONE conversion, TWO log rows', async () => {
  await makeClick('CLK1');
  const { body, sig } = signed(payload());
  const r1 = await post(app, body, sig);
  const r2 = await post(app, body, sig);
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(r2.body, r1.body);
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM conversion_records`)).c, 1);
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM postback_log`)).c, 2);
  assert.strictEqual((await db.getAsync(`SELECT outcome FROM postback_log ORDER BY id DESC LIMIT 1`)).outcome, 'duplicate');
});

test('one click -> many conversions (distinct external_ref), all linked, click stays converted', async () => {
  await makeClick('CLK1');
  await post(app, ...Object.values(signed(payload({ external_ref: 'X1', conversion_type: 'registration' }))));
  await post(app, ...Object.values(signed(payload({ external_ref: 'X2', conversion_type: 'first_time_deposit' }))));
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM conversion_records WHERE click_id='CLK1'`)).c, 2);
  assert.strictEqual((await repo.findClick('CLK1')).status, 'converted');
});
