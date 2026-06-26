// requireAuth middleware: the gate every value-bearing endpoint sits behind.
// Verified in isolation on a tiny app so the suite needs no DB and no running
// server — exactly the security contract server.js relies on:
//   - no/garbage/expired token            -> 401
//   - valid token                         -> req.userId pinned to the token's id
//   - body/query userId that disagrees    -> 403 (never trust the client's id)
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('./affiliate/request');
const requireAuth = require('../auth/requireAuth');
const { secretKey } = require('../auth/secret');

// Minimal app exposing one protected route on both verbs. The handler echoes
// req.userId so a test can prove the scope came from the token, not the body.
function makeApp() {
  const app = express();
  app.use(express.json());
  const echo = (req, res) => res.json({ userId: req.userId });
  app.get('/api/protected', requireAuth, echo);
  app.post('/api/protected', requireAuth, echo);
  return app;
}

const tokenFor = (id, opts) => jwt.sign({ id }, secretKey, opts || { expiresIn: '1h' });

test('missing Authorization header -> 401', async () => {
  const res = await request(makeApp()).get('/api/protected');
  assert.strictEqual(res.status, 401);
});

test('non-Bearer Authorization header -> 401', async () => {
  const res = await request(makeApp()).get('/api/protected').set('Authorization', 'Basic abc123');
  assert.strictEqual(res.status, 401);
});

test('garbage token -> 401', async () => {
  const res = await request(makeApp()).get('/api/protected').set('Authorization', 'Bearer not.a.real.jwt');
  assert.strictEqual(res.status, 401);
});

test('token signed with the wrong secret -> 401', async () => {
  const forged = jwt.sign({ id: 1 }, 'a-different-secret', { expiresIn: '1h' });
  const res = await request(makeApp()).get('/api/protected').set('Authorization', `Bearer ${forged}`);
  assert.strictEqual(res.status, 401);
});

test('expired token -> 401', async () => {
  const expired = tokenFor(5, { expiresIn: -10 });
  const res = await request(makeApp()).get('/api/protected').set('Authorization', `Bearer ${expired}`);
  assert.strictEqual(res.status, 401);
});

test('valid token scopes req.userId to the token subject', async () => {
  const res = await request(makeApp()).get('/api/protected').set('Authorization', `Bearer ${tokenFor(42)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.userId, 42);
});

test('a matching userId in the body is allowed (scope still from token)', async () => {
  const res = await request(makeApp())
    .post('/api/protected')
    .set('Authorization', `Bearer ${tokenFor(7)}`)
    .send({ userId: 7 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.userId, 7);
});

test('a mismatched userId in the body is rejected with 403', async () => {
  // The classic IDOR: user 7 tries to act as user 999 by spoofing the body.
  const res = await request(makeApp())
    .post('/api/protected')
    .set('Authorization', `Bearer ${tokenFor(7)}`)
    .send({ userId: 999 });
  assert.strictEqual(res.status, 403);
});

test('a mismatched userId in the query string is rejected with 403', async () => {
  const res = await request(makeApp())
    .get('/api/protected?userId=999')
    .set('Authorization', `Bearer ${tokenFor(7)}`);
  assert.strictEqual(res.status, 403);
});
