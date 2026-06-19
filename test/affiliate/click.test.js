const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('./request');
const { freshDb, cleanup, makeApp } = require('./helpers');

let app, file, repo;
before(async () => { const f = await freshDb(); file = f.file; repo = require('../../affiliate/repo'); app = makeApp(); });
after(() => cleanup(file));

const ctx = { userId: 6, book: 'mock_book', event_id: 'e1', match_id: 'm1', market_id: 'mk1',
  selection_id: 's1', participant_id: 'p1', source_page: 'live' };

test('POST /click -> 201 with ULID click_id + deep link', async () => {
  const res = await request(app).post('/api/affiliate/click').send(ctx);
  assert.strictEqual(res.status, 201);
  assert.match(res.body.click_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(res.body.deep_link_url.startsWith('http://localhost:4100/bet?'));
  assert.ok(res.body.deep_link_url.includes(`click_id=${res.body.click_id}`));
});

test('region is resolved server-side and is NOT taken from the body', async () => {
  const res = await request(app).post('/api/affiliate/click').send({ ...ctx, region: 'US' });
  const row = await repo.findClick(res.body.click_id);
  assert.strictEqual(row.region, 'BR');
});

test('deep link carries tracking params only - no user id / PII', async () => {
  const res = await request(app).post('/api/affiliate/click').send(ctx);
  assert.ok(!res.body.deep_link_url.includes('userId'));
  assert.ok(!res.body.deep_link_url.includes('user_id'));
});

test('missing required context -> 400', async () => {
  const res = await request(app).post('/api/affiliate/click').send({ userId: 6 });
  assert.strictEqual(res.status, 400);
});
