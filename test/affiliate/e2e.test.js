const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('./request');
const { freshDb, cleanup, makeApp } = require('./helpers');
const bookSign = require('../../mock-book/hmac');
const config = require('../../affiliate/config');

let app, file, db;
before(async () => { const f = await freshDb(); file = f.file; db = f.db; app = makeApp(); });
after(() => cleanup(file));

test('full loop: click -> deep link -> book signs -> postback reconciles -> resend dedupes', async () => {
  // 1) click
  const click = await request(app).post('/api/affiliate/click').send({
    userId: 6, book: 'mock_book', event_id: 'e1', match_id: 'm1', market_id: 'mk1',
    selection_id: 's1', participant_id: 'p1', source_page: 'live' });
  const url = new URL(click.body.deep_link_url);
  const clickId = url.searchParams.get('click_id');     // the book reads it off the deep link
  assert.strictEqual(clickId, click.body.click_id);

  // 2) book builds + signs the postback (its own signer, shared secret value)
  const body = JSON.stringify({ book: 'mock_book', click_id: clickId, external_ref: 'BK-1',
    conversion_type: 'first_time_deposit', amount: 5000, currency: 'BRL', commission_model: 'cpa', commission_value: 12000 });
  const sig = bookSign(Buffer.from(body), config.hmacSecret);

  // 3) postback reconciles
  const r1 = await request(app).post('/api/affiliate/postback').set('Content-Type', 'application/json').set('X-MM-Signature', sig).send(body);
  assert.strictEqual(r1.status, 200);
  const conv = await db.getAsync(`SELECT * FROM conversion_records WHERE click_id = ?`, [clickId]);
  assert.strictEqual(conv.external_ref, 'BK-1');
  assert.strictEqual(conv.validation_status, 'pending');

  // 4) resend identical bytes -> idempotent, still ONE conversion, TWO log rows
  const r2 = await request(app).post('/api/affiliate/postback').set('Content-Type', 'application/json').set('X-MM-Signature', sig).send(body);
  assert.deepStrictEqual(r2.body, r1.body);
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM conversion_records`)).c, 1);
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM postback_log`)).c, 2);
});
