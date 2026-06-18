# Mock Sportsbook + Affiliate Attribution Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove Money Match's side of the affiliate handoff — the outbound→inbound attribution loop — using a standalone mock sportsbook, so the exact code path works unchanged against a real book later.

**Architecture:** Money Match's existing Express backend (`:5000`) gains a self-contained `affiliate/` module (two public endpoints + two dev endpoints, HMAC verification, three SQLite tables). A separate `mock-book/` Express service (`:4100`) stands in for a licensed book: it lands the deep link, echoes tracking params, and sends a real cross-origin HMAC-signed S2S postback. A minimal client demo page triggers the loop. No shared DB/session/code between the two services; the HMAC secret is configured independently in each.

**Tech Stack:** Node 18 + Express, SQLite (`sqlite3` via `db/db.js`), `ulid` for ids, `crypto` HMAC (`createHmac` + `timingSafeEqual`), `node:test` runner + `supertest` for HTTP tests, React (CRA) for the demo trigger.

**Spec:** `docs/superpowers/specs/2026-06-18-mock-sportsbook-affiliate-design.md` (authoritative; §11 refinements are binding).

**Conventions in this repo (follow them):**
- DB access via `db/db.js`: `db.getAsync(sql, params)`, `db.allAsync(...)`, `db.runAsync(...)` (returns the statement: `.lastID`, `.changes`). DB file from `process.env.DATABASE_PATH || './database.db'`.
- Schema changes go in an idempotent `scripts/migrate-*.js` (pattern: `scripts/migrate-live-betting.js`).
- Money/commission amounts are **integer minor units** (cents). Timestamps are ISO-UTC strings (`new Date().toISOString()`).

---

## File structure

**Money Match backend (new `affiliate/` module — each file one responsibility):**
- `affiliate/config.js` — reads + defaults the affiliate env vars.
- `affiliate/ids.js` — ULID generation.
- `affiliate/hmac.js` — `sign` / `verify` (constant-time).
- `affiliate/window.js` — `isWithinWindow` (inclusive expiry boundary).
- `affiliate/region.js` — server-side region resolution (geo-IP seam; dev fallback).
- `affiliate/repo.js` — all DB access for the three tables.
- `affiliate/router.js` — the Express router (`/click`, `/postback`, `/conversions/:id/validate`, `/conversions/:id/reject`).
- `server.js` — **modify**: add `verify` callback to global `express.json`; mount the router.
- `scripts/migrate-affiliate.js` — creates `click_records`, `postback_log`, `conversion_records`.

**Mock-book service (separate, reuses root `node_modules`):**
- `mock-book/hmac.js` — its **own** `sign` (not imported from `affiliate/`).
- `mock-book/server.js` — `:4100` Express: `GET /bet`, `POST /confirm`, `POST /resend`.
- `mock-book/.env.example` — its config (own HMAC secret).

**Client (minimal demo trigger):**
- `client/src/components/AffiliateHandoff.js` — the "Place on [Book]" button.
- `client/src/components/AffiliateDemo.js` — a tiny page to drive it.
- `client/src/App.js` — **modify**: add `/affiliate-demo` route.

**Tests (`node:test` + `supertest`):**
- `test/affiliate/helpers.js` — temp-DB + test-app harness.
- `test/affiliate/hmac.test.js`, `ids.test.js`, `window.test.js`, `repo.test.js`, `click.test.js`, `postback.test.js`, `conversions.test.js`, `e2e.test.js`.
- `test/mock-book/sign.test.js`.

**Config:**
- `package.json` — **modify**: add `ulid` dep, `supertest` dev dep, `test:affiliate` script.
- `.env` (gitignored) / `.env.example` — affiliate vars.

---

## Task 0: Project setup — deps, env, schema migration

**Files:**
- Modify: `package.json`
- Create: `scripts/migrate-affiliate.js`
- Create/Modify: `.env.example`, `mock-book/.env.example`

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install ulid
npm install --save-dev supertest
```
Expected: `ulid` appears in `dependencies`, `supertest` in `devDependencies`.

- [ ] **Step 2: Add the test script to `package.json`**

In `package.json` `"scripts"`, add:
```json
"test:affiliate": "node --test test/affiliate test/mock-book"
```

- [ ] **Step 3: Write the migration `scripts/migrate-affiliate.js`**

```js
/**
 * Idempotent schema migration for the affiliate attribution loop.
 * Creates click_records, postback_log, conversion_records.
 * Usage:
 *   node scripts/migrate-affiliate.js
 *   DATABASE_PATH=./db/test.db node scripts/migrate-affiliate.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('../db/db');

async function migrate() {
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS click_records (
      click_id      TEXT PRIMARY KEY,
      user_id       INTEGER,
      region        TEXT,
      book          TEXT,
      affiliate_id  TEXT,
      event_id TEXT, match_id TEXT, market_id TEXT, selection_id TEXT, participant_id TEXT,
      source_page   TEXT,
      deep_link_url TEXT,
      status        TEXT NOT NULL DEFAULT 'clicked',   -- clicked|converted|expired
      created_at    TEXT NOT NULL
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_click_book ON click_records(book)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_click_status ON click_records(status)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_click_created ON click_records(created_at)`);
  console.log('click_records ready');

  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS postback_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at     TEXT NOT NULL,
      remote_ip       TEXT,
      signature_valid INTEGER,                 -- null until verified, then 0/1
      book TEXT, external_ref TEXT, click_id TEXT,
      outcome         TEXT,                    -- received|rejected_signature|malformed|duplicate|unmatched|expired|reconciled
      raw_payload     TEXT NOT NULL
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_plog_received ON postback_log(received_at)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_plog_click ON postback_log(click_id)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_plog_ref ON postback_log(book, external_ref)`);
  console.log('postback_log ready');

  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS conversion_records (
      conversion_id     TEXT PRIMARY KEY,
      postback_log_id   INTEGER,
      click_id          TEXT,
      book TEXT, external_ref TEXT,
      conversion_type   TEXT,
      amount            INTEGER,                -- minor units
      currency          TEXT NOT NULL,
      commission_model  TEXT,
      commission_value  INTEGER,                -- minor units
      validation_status TEXT NOT NULL DEFAULT 'pending',  -- pending|validated|rejected
      received_at TEXT,
      resolved_at TEXT,
      UNIQUE (book, external_ref),
      FOREIGN KEY (postback_log_id) REFERENCES postback_log (id),
      FOREIGN KEY (click_id) REFERENCES click_records (click_id)
    )
  `);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_conv_click ON conversion_records(click_id)`);
  await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_conv_status ON conversion_records(validation_status)`);
  console.log('conversion_records ready');

  console.log('Affiliate migration complete.');
}

migrate().then(() => process.exit(0)).catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
```

- [ ] **Step 4: Run the migration against the real DB**

Run: `DATABASE_PATH=./db/database.db node scripts/migrate-affiliate.js`
Expected: prints `click_records ready` / `postback_log ready` / `conversion_records ready` / `Affiliate migration complete.`

- [ ] **Step 5: Add env examples**

Append to `.env.example` (create if missing):
```
# --- Affiliate attribution loop ---
AFFILIATE_HMAC_SECRET=dev-shared-secret-change-me
MOCK_BOOK_URL=http://localhost:4100
MOCK_AFFILIATE_ID=mm-mock-01
AFFILIATE_DEV_REGION=BR
ATTRIBUTION_WINDOW_DAYS=30
```
Create `mock-book/.env.example`:
```
PORT=4100
MONEY_MATCH_POSTBACK_URL=http://localhost:5000/api/affiliate/postback
# Same VALUE as Money Match's AFFILIATE_HMAC_SECRET, configured independently here:
MOCK_BOOK_HMAC_SECRET=dev-shared-secret-change-me
```
Also set these in your real `.env` (gitignored) so the services run.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/migrate-affiliate.js .env.example mock-book/.env.example
git commit -m "chore(affiliate): deps, env, schema migration for attribution loop"
```

---

## Task 1: Config + IDs

**Files:**
- Create: `affiliate/config.js`, `affiliate/ids.js`
- Test: `test/affiliate/ids.test.js`

- [ ] **Step 1: Write `affiliate/config.js`**

```js
// Reads affiliate env with sane dev defaults. One source of truth for config.
module.exports = {
  hmacSecret: process.env.AFFILIATE_HMAC_SECRET || 'dev-shared-secret-change-me',
  mockBookUrl: process.env.MOCK_BOOK_URL || 'http://localhost:4100',
  mockAffiliateId: process.env.MOCK_AFFILIATE_ID || 'mm-mock-01',
  devRegion: process.env.AFFILIATE_DEV_REGION || 'BR',
  windowDays: Number(process.env.ATTRIBUTION_WINDOW_DAYS || 30),
};
```

- [ ] **Step 2: Write the failing test `test/affiliate/ids.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { newId } = require('../../affiliate/ids');

test('newId returns a 26-char ULID', () => {
  const id = newId();
  assert.strictEqual(typeof id, 'string');
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/); // Crockford base32
});

test('newId is unique across calls', () => {
  const a = newId(), b = newId();
  assert.notStrictEqual(a, b);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/affiliate/ids.test.js`
Expected: FAIL — `Cannot find module '../../affiliate/ids'`.

- [ ] **Step 4: Write `affiliate/ids.js`**

```js
const { ulid } = require('ulid');
// Sortable, unguessable, unique id for click_id / conversion_id.
function newId() { return ulid(); }
module.exports = { newId };
```

- [ ] **Step 5: Run it to verify it passes**

Run: `node --test test/affiliate/ids.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add affiliate/config.js affiliate/ids.js test/affiliate/ids.test.js
git commit -m "feat(affiliate): config + ULID ids"
```

---

## Task 2: HMAC sign/verify (constant-time)

**Files:**
- Create: `affiliate/hmac.js`
- Test: `test/affiliate/hmac.test.js`

- [ ] **Step 1: Write the failing test `test/affiliate/hmac.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { sign, verify } = require('../../affiliate/hmac');

const SECRET = 'shared-secret';
const raw = Buffer.from(JSON.stringify({ a: 1, b: 'x' }));

test('verify accepts a signature produced by sign', () => {
  const sig = sign(raw, SECRET);
  assert.strictEqual(verify(raw, sig, SECRET), true);
});

test('verify rejects a tampered body', () => {
  const sig = sign(raw, SECRET);
  const tampered = Buffer.from(JSON.stringify({ a: 1, b: 'y' }));
  assert.strictEqual(verify(tampered, sig, SECRET), false);
});

test('verify rejects a wrong secret', () => {
  const sig = sign(raw, SECRET);
  assert.strictEqual(verify(raw, sig, 'other-secret'), false);
});

test('verify returns false (no throw) on a missing/garbage signature', () => {
  assert.strictEqual(verify(raw, undefined, SECRET), false);
  assert.strictEqual(verify(raw, 'not-hex', SECRET), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/affiliate/hmac.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `affiliate/hmac.js`**

```js
const crypto = require('crypto');

// HMAC-SHA256 of the exact raw bytes, hex-encoded.
function sign(rawBuffer, secret) {
  return crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex');
}

// Constant-time compare. Returns false (never throws) on any malformed input,
// including length mismatch (timingSafeEqual throws if lengths differ).
function verify(rawBuffer, signatureHex, secret) {
  if (typeof signatureHex !== 'string') return false;
  const expected = Buffer.from(sign(rawBuffer, secret), 'hex');
  let provided;
  try { provided = Buffer.from(signatureHex, 'hex'); } catch { return false; }
  if (provided.length !== expected.length || provided.length === 0) return false;
  return crypto.timingSafeEqual(provided, expected);
}

module.exports = { sign, verify };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/affiliate/hmac.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add affiliate/hmac.js test/affiliate/hmac.test.js
git commit -m "feat(affiliate): constant-time HMAC sign/verify"
```

---

## Task 3: Expiry window (inclusive boundary)

**Files:**
- Create: `affiliate/window.js`
- Test: `test/affiliate/window.test.js`

- [ ] **Step 1: Write the failing test `test/affiliate/window.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isWithinWindow } = require('../../affiliate/window');

const DAY = 24 * 60 * 60 * 1000;
const created = '2026-06-01T00:00:00.000Z';
const at = (ms) => new Date(Date.parse(created) + ms).toISOString();

test('within window (1 day later, 30-day window)', () => {
  assert.strictEqual(isWithinWindow(created, at(1 * DAY), 30), true);
});

test('exact boundary is inclusive (exactly window end → within)', () => {
  assert.strictEqual(isWithinWindow(created, at(30 * DAY), 30), true);
});

test('strictly beyond the boundary is expired', () => {
  assert.strictEqual(isWithinWindow(created, at(30 * DAY + 1), 30), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/affiliate/window.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `affiliate/window.js`**

```js
// Inclusive boundary: a postback at exactly created_at + windowDays is in-window;
// strictly beyond is expired. Computed from the stored created_at (never a ULID time).
function isWithinWindow(createdAtISO, receivedAtISO, windowDays) {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const elapsed = Date.parse(receivedAtISO) - Date.parse(createdAtISO);
  return elapsed <= windowMs; // <= = inclusive
}
module.exports = { isWithinWindow };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/affiliate/window.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add affiliate/window.js test/affiliate/window.test.js
git commit -m "feat(affiliate): inclusive expiry-window check"
```

---

## Task 4: Region resolution (server-side seam)

**Files:**
- Create: `affiliate/region.js`
- Test: `test/affiliate/region.test.js`

- [ ] **Step 1: Write the failing test `test/affiliate/region.test.js`**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveRegion } = require('../../affiliate/region');

test('resolveRegion returns the configured dev region, server-side', () => {
  // Even if a client tries to supply a region, it is ignored: resolveRegion
  // takes only the request, never the body.
  const req = { ip: '127.0.0.1', body: { region: 'US' } };
  assert.strictEqual(resolveRegion(req), process.env.AFFILIATE_DEV_REGION || 'BR');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/affiliate/region.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `affiliate/region.js`**

```js
const config = require('./config');
// Server-side region resolution. SEAM: a real geo-IP lookup of req.ip plugs in
// here later. For this task (geo-routing out of scope) we capture the configured
// dev region. NEVER read region from the client/body — spoofable, audit-useless.
function resolveRegion(_req) {
  return config.devRegion;
}
module.exports = { resolveRegion };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/affiliate/region.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add affiliate/region.js test/affiliate/region.test.js
git commit -m "feat(affiliate): server-side region resolution seam"
```

---

## Task 5: Repository (DB access for the three tables)

**Files:**
- Create: `affiliate/repo.js`
- Create: `test/affiliate/helpers.js`
- Test: `test/affiliate/repo.test.js`

- [ ] **Step 1: Write the temp-DB harness `test/affiliate/helpers.js`**

```js
const path = require('path');
const fs = require('fs');
const os = require('os');

// Point db/db.js at a fresh temp SQLite file, run the affiliate migration,
// and return the db handle. MUST be called before requiring repo/router.
async function freshDb() {
  const file = path.join(os.tmpdir(), `mm-affiliate-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  // Fresh require so db/db.js picks up DATABASE_PATH.
  delete require.cache[require.resolve('../../db/db')];
  const db = require('../../db/db');
  await db.runAsync(`CREATE TABLE IF NOT EXISTS click_records (
    click_id TEXT PRIMARY KEY, user_id INTEGER, region TEXT, book TEXT, affiliate_id TEXT,
    event_id TEXT, match_id TEXT, market_id TEXT, selection_id TEXT, participant_id TEXT,
    source_page TEXT, deep_link_url TEXT, status TEXT NOT NULL DEFAULT 'clicked', created_at TEXT NOT NULL)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS postback_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL, remote_ip TEXT,
    signature_valid INTEGER, book TEXT, external_ref TEXT, click_id TEXT, outcome TEXT, raw_payload TEXT NOT NULL)`);
  await db.runAsync(`CREATE TABLE IF NOT EXISTS conversion_records (
    conversion_id TEXT PRIMARY KEY, postback_log_id INTEGER, click_id TEXT, book TEXT, external_ref TEXT,
    conversion_type TEXT, amount INTEGER, currency TEXT NOT NULL, commission_model TEXT, commission_value INTEGER,
    validation_status TEXT NOT NULL DEFAULT 'pending', received_at TEXT, resolved_at TEXT,
    UNIQUE (book, external_ref))`);
  return { db, file };
}

function cleanup(file) { try { fs.unlinkSync(file); } catch { /* ignore */ } }

module.exports = { freshDb, cleanup };
```

- [ ] **Step 2: Write the failing test `test/affiliate/repo.test.js`**

```js
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
  assert.strictEqual(await repo.earnedTotal(), 0); // rejected is not earned
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/affiliate/repo.test.js`
Expected: FAIL — `Cannot find module '../../affiliate/repo'`.

- [ ] **Step 4: Write `affiliate/repo.js`**

```js
const db = require('../db/db');

const COLS = ['click_id','user_id','region','book','affiliate_id','event_id','match_id',
  'market_id','selection_id','participant_id','source_page','deep_link_url','created_at'];

async function createClick(c) {
  await db.runAsync(
    `INSERT INTO click_records (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`,
    COLS.map((k) => c[k])
  );
}
function findClick(clickId) {
  return db.getAsync(`SELECT * FROM click_records WHERE click_id = ?`, [clickId]);
}
async function markClickConverted(clickId) {
  await db.runAsync(`UPDATE click_records SET status = 'converted' WHERE click_id = ?`, [clickId]);
}

async function logPostback({ received_at, remote_ip, raw_payload }) {
  const stmt = await db.runAsync(
    `INSERT INTO postback_log (received_at, remote_ip, signature_valid, outcome, raw_payload)
     VALUES (?, ?, NULL, 'received', ?)`,
    [received_at, remote_ip, raw_payload]
  );
  return stmt.lastID;
}
async function setPostbackResult(id, { signature_valid, outcome, book, external_ref, click_id }) {
  await db.runAsync(
    `UPDATE postback_log SET signature_valid = ?, outcome = ?, book = ?, external_ref = ?, click_id = ? WHERE id = ?`,
    [signature_valid == null ? null : (signature_valid ? 1 : 0), outcome, book ?? null, external_ref ?? null, click_id ?? null, id]
  );
}

const CONV_COLS = ['conversion_id','postback_log_id','click_id','book','external_ref','conversion_type',
  'amount','currency','commission_model','commission_value','received_at'];
async function insertConversion(c) {
  // Atomic dedupe: rely on UNIQUE(book, external_ref). Caller catches the violation.
  await db.runAsync(
    `INSERT INTO conversion_records (${CONV_COLS.join(',')}) VALUES (${CONV_COLS.map(() => '?').join(',')})`,
    CONV_COLS.map((k) => c[k])
  );
}
function isUniqueViolation(err) {
  return !!err && /UNIQUE constraint failed/i.test(err.message || '');
}
async function resolveConversion(conversionId, status, resolvedAt) {
  await db.runAsync(
    `UPDATE conversion_records SET validation_status = ?, resolved_at = ? WHERE conversion_id = ?`,
    [status, resolvedAt, conversionId]
  );
}
async function earnedTotal() {
  const row = await db.getAsync(
    `SELECT COALESCE(SUM(commission_value), 0) AS total FROM conversion_records WHERE validation_status = 'validated'`
  );
  return row.total;
}

module.exports = {
  createClick, findClick, markClickConverted,
  logPostback, setPostbackResult,
  insertConversion, isUniqueViolation, resolveConversion, earnedTotal,
};
```

- [ ] **Step 5: Run it to verify it passes**

Run: `node --test test/affiliate/repo.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add affiliate/repo.js test/affiliate/helpers.js test/affiliate/repo.test.js
git commit -m "feat(affiliate): repository for click/postback/conversion tables"
```

---

## Task 6: Router skeleton + `POST /click`

**Files:**
- Create: `affiliate/router.js`
- Test: `test/affiliate/click.test.js`

The test harness mounts the router on a minimal app that replicates server.js's
raw-body capture, so the router is tested in isolation.

- [ ] **Step 1: Add a test-app factory to `test/affiliate/helpers.js`**

Append to `test/affiliate/helpers.js` (before `module.exports`), and add `makeApp` to the exports:
```js
const express = require('express');
function makeApp() {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/affiliate', require('../../affiliate/router'));
  return app;
}
// Clear the three tables between tests that assert exact counts. One DB per
// file (created once in `before`); `beforeEach(resetTables)` isolates each test
// without re-creating the connection (repo caches its db handle at load).
async function resetTables(db) {
  await db.runAsync('DELETE FROM conversion_records');
  await db.runAsync('DELETE FROM postback_log');
  await db.runAsync('DELETE FROM click_records');
}
```
Update the export line to:
```js
module.exports = { freshDb, cleanup, makeApp, resetTables };
```

- [ ] **Step 2: Write the failing test `test/affiliate/click.test.js`**

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { freshDb, cleanup, makeApp } = require('./helpers');

let app, file, repo;
before(async () => { const f = await freshDb(); file = f.file; repo = require('../../affiliate/repo'); app = makeApp(); });
after(() => cleanup(file));

const ctx = { userId: 6, book: 'mock_book', event_id: 'e1', match_id: 'm1', market_id: 'mk1',
  selection_id: 's1', participant_id: 'p1', source_page: 'live' };

test('POST /click → 201 with ULID click_id + deep link', async () => {
  const res = await request(app).post('/api/affiliate/click').send(ctx);
  assert.strictEqual(res.status, 201);
  assert.match(res.body.click_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(res.body.deep_link_url.startsWith('http://localhost:4100/bet?'));
  assert.ok(res.body.deep_link_url.includes(`click_id=${res.body.click_id}`));
});

test('region is resolved server-side and is NOT taken from the body', async () => {
  const res = await request(app).post('/api/affiliate/click').send({ ...ctx, region: 'US' });
  const row = await repo.findClick(res.body.click_id);
  assert.strictEqual(row.region, 'BR'); // dev region, not the client-sent 'US'
});

test('deep link carries tracking params only — no user id / PII', async () => {
  const res = await request(app).post('/api/affiliate/click').send(ctx);
  assert.ok(!res.body.deep_link_url.includes('userId'));
  assert.ok(!res.body.deep_link_url.includes('user_id'));
});

test('missing required context → 400', async () => {
  const res = await request(app).post('/api/affiliate/click').send({ userId: 6 });
  assert.strictEqual(res.status, 400);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/affiliate/click.test.js`
Expected: FAIL — `Cannot find module '../../affiliate/router'`.

- [ ] **Step 4: Write `affiliate/router.js` (click route only for now)**

```js
const express = require('express');
const config = require('./config');
const repo = require('./repo');
const { newId } = require('./ids');
const { resolveRegion } = require('./region');

const router = express.Router();

const REQUIRED = ['event_id', 'match_id', 'market_id', 'selection_id', 'participant_id', 'source_page'];
const SOURCE_PAGES = new Set(['home', 'live', 'futures', 'match_detail']);

router.post('/click', async (req, res) => {
  const b = req.body || {};
  for (const k of REQUIRED) if (!b[k]) return res.status(400).json({ error: `missing ${k}` });
  if (!SOURCE_PAGES.has(b.source_page)) return res.status(400).json({ error: 'invalid source_page' });

  const click_id = newId();
  const region = resolveRegion(req);                 // server-side; body.region ignored
  const book = b.book || 'mock_book';
  const affiliate_id = config.mockAffiliateId;

  const params = new URLSearchParams({
    click_id, affiliate_id, book,
    event_id: b.event_id, match_id: b.match_id, market_id: b.market_id,
    selection_id: b.selection_id, participant_id: b.participant_id,
  });
  const deep_link_url = `${config.mockBookUrl}/bet?${params.toString()}`;

  await repo.createClick({
    click_id, user_id: b.userId ?? null, region, book, affiliate_id,
    event_id: b.event_id, match_id: b.match_id, market_id: b.market_id,
    selection_id: b.selection_id, participant_id: b.participant_id,
    source_page: b.source_page, deep_link_url, created_at: new Date().toISOString(),
  });

  res.status(201).json({ click_id, deep_link_url });
});

module.exports = router;
```

- [ ] **Step 5: Run it to verify it passes**

Run: `node --test test/affiliate/click.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add affiliate/router.js test/affiliate/click.test.js test/affiliate/helpers.js
git commit -m "feat(affiliate): POST /click mints tracked click + deep link"
```

---

## Task 7: `POST /postback` — verify → dedupe → reconcile

**Files:**
- Modify: `affiliate/router.js`
- Test: `test/affiliate/postback.test.js`

- [ ] **Step 1: Write the failing test `test/affiliate/postback.test.js`**

```js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { freshDb, cleanup, makeApp, resetTables } = require('./helpers');
const { sign } = require('../../affiliate/hmac');
const config = require('../../affiliate/config');

let app, file, repo, db;
before(async () => { const f = await freshDb(); file = f.file; db = f.db; repo = require('../../affiliate/repo'); app = makeApp(); });
beforeEach(async () => { await resetTables(db); }); // each test starts with empty tables
after(() => cleanup(file));

// Make a click to convert against. created_at lets us force the expiry cases.
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

test('valid + matched → 200, conversion pending, click converted, log reconciled', async () => {
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

test('invalid signature → 401, logged rejected_signature, no conversion, no click change', async () => {
  await makeClick('CLK1');
  const res = await post(app, payload(), 'deadbeef');
  assert.strictEqual(res.status, 401);
  assert.strictEqual((await repo.findClick('CLK1')).status, 'clicked');
  const cnt = await db.getAsync(`SELECT COUNT(*) c FROM conversion_records`);
  assert.strictEqual(cnt.c, 0);
  const log = await db.getAsync(`SELECT * FROM postback_log ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(log.outcome, 'rejected_signature');
  assert.strictEqual(log.signature_valid, 0);
});

test('raw persisted before verify — a forged payload still appears in postback_log', async () => {
  const res = await post(app, payload(), 'deadbeef');
  assert.strictEqual(res.status, 401);
  const log = await db.getAsync(`SELECT * FROM postback_log ORDER BY id DESC LIMIT 1`);
  assert.ok(log.raw_payload.includes('first_time_deposit'));
});

test('PRECEDENCE: invalid signature AND malformed body → 401 (gate before parse)', async () => {
  const { sig } = signed('{bad json'); // sign is irrelevant; we send a wrong sig
  const res = await post(app, '{bad json', 'deadbeef');
  assert.strictEqual(res.status, 401);
});

test('valid signature + malformed body → 400, logged malformed, no conversion', async () => {
  const body = '{not valid json';
  const sig = sign(Buffer.from(body), config.hmacSecret);
  const res = await post(app, body, sig);
  assert.strictEqual(res.status, 400);
  const log = await db.getAsync(`SELECT * FROM postback_log ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(log.outcome, 'malformed');
});

test('unknown click_id → 200, logged unmatched, no conversion', async () => {
  const { body, sig } = signed(payload({ click_id: 'NOPE' }));
  const res = await post(app, body, sig);
  assert.strictEqual(res.status, 200);
  const log = await db.getAsync(`SELECT * FROM postback_log ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(log.outcome, 'unmatched');
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM conversion_records`)).c, 0);
});

test('expired click_id → 200, logged expired, no conversion', async () => {
  const old = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  await makeClick('CLK1', old);
  const { body, sig } = signed(payload());
  const res = await post(app, body, sig);
  assert.strictEqual(res.status, 200);
  const log = await db.getAsync(`SELECT * FROM postback_log ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(log.outcome, 'expired');
});

test('duplicate (book,external_ref) → idempotent 200, ONE conversion, TWO log rows', async () => {
  await makeClick('CLK1');
  const { body, sig } = signed(payload());
  const r1 = await post(app, body, sig);
  const r2 = await post(app, body, sig); // identical resend
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(r2.body, r1.body); // same idempotent ack
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM conversion_records`)).c, 1);
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM postback_log`)).c, 2);
  assert.strictEqual((await db.getAsync(`SELECT outcome FROM postback_log ORDER BY id DESC LIMIT 1`)).outcome, 'duplicate');
});

test('one click → many conversions (distinct external_ref), all linked, click stays converted', async () => {
  await makeClick('CLK1');
  await post(app, ...Object.values(signed(payload({ external_ref: 'X1', conversion_type: 'registration' }))));
  await post(app, ...Object.values(signed(payload({ external_ref: 'X2', conversion_type: 'first_time_deposit' }))));
  const cnt = await db.getAsync(`SELECT COUNT(*) c FROM conversion_records WHERE click_id='CLK1'`);
  assert.strictEqual(cnt.c, 2);
  assert.strictEqual((await repo.findClick('CLK1')).status, 'converted');
});
```
*(Note: `post(app, ...Object.values(signed(...)))` spreads `{body, sig}` — keep `signed` returning `{ body, sig }` in that order.)*

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/affiliate/postback.test.js`
Expected: FAIL — route returns 404 (postback not implemented).

- [ ] **Step 3: Add the postback route to `affiliate/router.js`**

Add these requires at the top of `affiliate/router.js` (alongside the existing ones):
```js
const { verify } = require('./hmac');
const { isWithinWindow } = require('./window');
const { newId } = require('./ids'); // already imported in Task 6
```
Append the route before `module.exports = router;`:
```js
const ACK = { received: true }; // uniform 200 ack — a duplicate is byte-identical

router.post('/postback', async (req, res) => {
  const raw = req.rawBody || Buffer.from('');
  const received_at = new Date().toISOString();
  const remote_ip = req.ip;

  // 1) Persist raw FIRST, before any verify/parse.
  const logId = await repo.logPostback({ received_at, remote_ip, raw_payload: raw.toString('utf8') });

  // 2) Verify HMAC (constant-time) BEFORE parsing the body.
  const sigValid = verify(raw, req.get('X-MM-Signature'), config.hmacSecret);
  if (!sigValid) {
    await repo.setPostbackResult(logId, { signature_valid: false, outcome: 'rejected_signature' });
    return res.status(401).json({ error: 'invalid signature' });
  }

  // 3) Parse.
  let p;
  try { p = JSON.parse(raw.toString('utf8')); }
  catch { await repo.setPostbackResult(logId, { signature_valid: true, outcome: 'malformed' }); return res.status(400).json({ error: 'malformed' }); }
  const required = ['book', 'click_id', 'external_ref', 'conversion_type', 'currency'];
  for (const k of required) {
    if (p[k] == null) { await repo.setPostbackResult(logId, { signature_valid: true, outcome: 'malformed', book: p.book, external_ref: p.external_ref, click_id: p.click_id }); return res.status(400).json({ error: `missing ${k}` }); }
  }
  const ctx = { signature_valid: true, book: p.book, external_ref: p.external_ref, click_id: p.click_id };

  // 4) Resolve the click. Unknown / expired short-circuit (no conversion).
  const click = await repo.findClick(p.click_id);
  if (!click) { await repo.setPostbackResult(logId, { ...ctx, outcome: 'unmatched' }); return res.status(200).json(ACK); }
  if (!isWithinWindow(click.created_at, received_at, config.windowDays)) {
    await repo.setPostbackResult(logId, { ...ctx, outcome: 'expired' }); return res.status(200).json(ACK);
  }

  // 5) Reconcile via an ATOMIC insert — the UNIQUE(book, external_ref) is the dedupe.
  try {
    await repo.insertConversion({
      conversion_id: newId(), postback_log_id: logId, click_id: p.click_id, book: p.book,
      external_ref: p.external_ref, conversion_type: p.conversion_type, amount: p.amount ?? null,
      currency: p.currency, commission_model: p.commission_model ?? null,
      commission_value: p.commission_value ?? null, received_at,
    });
  } catch (err) {
    if (repo.isUniqueViolation(err)) { // resend → idempotent ack, no double-count, no state change
      await repo.setPostbackResult(logId, { ...ctx, outcome: 'duplicate' });
      return res.status(200).json(ACK);
    }
    throw err;
  }
  await repo.markClickConverted(p.click_id); // one click may convert many times; never blocks
  await repo.setPostbackResult(logId, { ...ctx, outcome: 'reconciled' });
  return res.status(200).json(ACK);
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/affiliate/postback.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add affiliate/router.js test/affiliate/postback.test.js
git commit -m "feat(affiliate): POST /postback verify→dedupe→reconcile pipeline"
```

---

## Task 8: Conversion hold — `validate` / `reject` dev endpoints

**Files:**
- Modify: `affiliate/router.js`
- Test: `test/affiliate/conversions.test.js`

- [ ] **Step 1: Write the failing test `test/affiliate/conversions.test.js`**

```js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { freshDb, cleanup, makeApp, resetTables } = require('./helpers');
const { sign } = require('../../affiliate/hmac');
const config = require('../../affiliate/config');

let app, file, repo, db;
before(async () => { const f = await freshDb(); file = f.file; db = f.db; repo = require('../../affiliate/repo'); app = makeApp(); });
beforeEach(async () => { await resetTables(db); }); // each test self-seeds against empty tables
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

test('pending is not earned; validate → validated (earned); resolved_at set', async () => {
  const id = await seedConversion();
  assert.strictEqual(await repo.earnedTotal(), 0); // pending excluded
  const res = await request(app).post(`/api/affiliate/conversions/${id}/validate`);
  assert.strictEqual(res.status, 200);
  const row = await db.getAsync(`SELECT * FROM conversion_records WHERE conversion_id = ?`, [id]);
  assert.strictEqual(row.validation_status, 'validated');
  assert.ok(row.resolved_at);
  assert.strictEqual(await repo.earnedTotal(), 12000);
});

test('reject → rejected, not earned', async () => {
  const id = await seedConversion('X9', 7000);
  const res = await request(app).post(`/api/affiliate/conversions/${id}/reject`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await db.getAsync(`SELECT validation_status FROM conversion_records WHERE conversion_id = ?`, [id])).validation_status, 'rejected');
  assert.strictEqual(await repo.earnedTotal(), 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/affiliate/conversions.test.js`
Expected: FAIL — routes return 404.

- [ ] **Step 3: Add the dev endpoints to `affiliate/router.js`**

Append before `module.exports = router;`:
```js
async function resolve(req, res, status) {
  await repo.resolveConversion(req.params.id, status, new Date().toISOString());
  res.status(200).json({ conversion_id: req.params.id, validation_status: status });
}
router.post('/conversions/:id/validate', (req, res) => resolve(req, res, 'validated'));
router.post('/conversions/:id/reject', (req, res) => resolve(req, res, 'rejected'));
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/affiliate/conversions.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole affiliate suite**

Run: `node --test test/affiliate`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add affiliate/router.js test/affiliate/conversions.test.js
git commit -m "feat(affiliate): conversion validate/reject hold endpoints"
```

---

## Task 9: Mount the affiliate module in `server.js`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Capture raw bytes on the global JSON parser**

In `server.js`, change line ~20:
```js
app.use(express.json()); // Parse JSON bodies
```
to:
```js
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })); // raw bytes for HMAC
```

- [ ] **Step 2: Mount the router**

After the other `app.use(...)` / route definitions in `server.js` (e.g., just after the `cors`/`json`/`static` block, before the SPA catch-all `app.get('*', ...)`), add:
```js
app.use('/api/affiliate', require('./affiliate/router'));
```
Placement matters: it must be **before** the `app.get('*', …)` catch-all so the API routes are not swallowed by the SPA fallback.

- [ ] **Step 3: Manual smoke test**

Run (two terminals):
```bash
DATABASE_PATH=./db/database.db node scripts/migrate-affiliate.js   # once
node server.js
```
Then:
```bash
curl -s -XPOST localhost:5000/api/affiliate/click -H 'Content-Type: application/json' \
  -d '{"userId":6,"book":"mock_book","event_id":"e1","match_id":"m1","market_id":"mk1","selection_id":"s1","participant_id":"p1","source_page":"live"}'
```
Expected: `201` JSON with `click_id` (26-char ULID) and a `deep_link_url` to `localhost:4100/bet?...`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(affiliate): mount router + capture raw body for HMAC in server.js"
```

---

## Task 10: Mock-book service (`:4100`)

**Files:**
- Create: `mock-book/hmac.js`, `mock-book/server.js`
- Test: `test/mock-book/sign.test.js`

- [ ] **Step 1: Write the failing test `test/mock-book/sign.test.js`**

This proves the mock signs with its own code such that Money Match's verifier accepts it — the two-parties-shared-secret property.
```js
const { test } = require('node:test');
const assert = require('node:assert');
const bookSign = require('../../mock-book/hmac');          // mock book's OWN sign
const { verify } = require('../../affiliate/hmac');         // Money Match's verify

test('mock-book signature verifies under Money Match with the same secret', () => {
  const secret = 'shared';
  const raw = Buffer.from(JSON.stringify({ book: 'mock_book', external_ref: 'X1' }));
  const sig = bookSign(raw, secret);
  assert.strictEqual(verify(raw, sig, secret), true);
});

test('a different secret does NOT verify', () => {
  const raw = Buffer.from('{}');
  assert.strictEqual(verify(raw, bookSign(raw, 'a'), 'b'), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/mock-book/sign.test.js`
Expected: FAIL — `Cannot find module '../../mock-book/hmac'`.

- [ ] **Step 3: Write `mock-book/hmac.js` (the book's OWN copy — not imported from affiliate/)**

```js
const crypto = require('crypto');
// The mock book's own signer. Intentionally a separate file from affiliate/hmac.js:
// in production the book holds its own copy of the shared secret and signing code.
module.exports = function sign(rawBuffer, secret) {
  return crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex');
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test test/mock-book/sign.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Write `mock-book/server.js`**

```js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const express = require('express');
const sign = require('./hmac');

const PORT = Number(process.env.PORT || 4100);
const POSTBACK_URL = process.env.MONEY_MATCH_POSTBACK_URL || 'http://localhost:5000/api/affiliate/postback';
const SECRET = process.env.MOCK_BOOK_HMAC_SECRET || 'dev-shared-secret-change-me';

const app = express();
app.use(express.urlencoded({ extended: true }));

let lastPostback = null; // { body, sig } — for the "Resend" affordance

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Deep-link landing: echo EVERY received tracking param (the verification window).
app.get('/bet', (req, res) => {
  const q = req.query;
  const rows = Object.entries(q).map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`).join('');
  res.send(`<!doctype html><meta charset="utf-8"><title>Mock Book</title>
  <h1>Mock Sportsbook — bet landing</h1>
  <p>Tracking params received via the deep link:</p>
  <table border=1 cellpadding=6>${rows}</table>
  <form method="post" action="/confirm">
    ${Object.entries(q).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
    <p><button type="submit">Confirm bet</button></p>
  </form>
  <form method="post" action="/resend"><button type="submit">Resend last postback</button></form>`);
});

async function send(body, sig) {
  lastPostback = { body, sig };
  const r = await fetch(POSTBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MM-Signature': sig }, body });
  return { status: r.status, text: await r.text() };
}

// Build → sign → real cross-origin S2S postback to Money Match.
app.post('/confirm', async (req, res) => {
  const q = req.body;
  const payload = {
    book: q.book || 'mock_book',
    click_id: q.click_id,
    external_ref: `mockbook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversion_type: 'first_time_deposit',
    amount: 5000, currency: 'BRL',
    commission_model: 'cpa', commission_value: 12000,
  };
  const body = JSON.stringify(payload);
  const sig = sign(Buffer.from(body), SECRET);
  const out = await send(body, sig);
  res.send(`<h1>Postback sent</h1><p>Money Match responded <b>${out.status}</b>: <code>${esc(out.text)}</code></p>
    <p>external_ref: <code>${esc(payload.external_ref)}</code></p><a href="javascript:history.back()">back</a>`);
});

// Resend the EXACT last signed bytes — demonstrates the idempotent/dedupe path.
app.post('/resend', async (req, res) => {
  if (!lastPostback) return res.send('<p>No postback sent yet.</p>');
  const out = await send(lastPostback.body, lastPostback.sig);
  res.send(`<h1>Resent identical postback</h1><p>Money Match responded <b>${out.status}</b>: <code>${esc(out.text)}</code></p>`);
});

app.listen(PORT, () => console.log(`Mock book on http://localhost:${PORT}`));
```
*(`fetch` is global in Node 18.)*

- [ ] **Step 6: Commit**

```bash
git add mock-book/hmac.js mock-book/server.js test/mock-book/sign.test.js
git commit -m "feat(mock-book): :4100 landing + signed S2S postback + resend"
```

---

## Task 11: End-to-end loop test

**Files:**
- Test: `test/affiliate/e2e.test.js`

Drives the whole loop in-process: `/click` → simulate the book signing the deep
link's `click_id` → `/postback` → assert reconciliation; then resend → duplicate.

- [ ] **Step 1: Write `test/affiliate/e2e.test.js`**

```js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { freshDb, cleanup, makeApp } = require('./helpers');
const bookSign = require('../../mock-book/hmac');
const config = require('../../affiliate/config');

let app, file, db;
before(async () => { const f = await freshDb(); file = f.file; db = f.db; app = makeApp(); });
after(() => cleanup(file));

test('full loop: click → deep link → book signs → postback reconciles → resend dedupes', async () => {
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

  // 4) resend identical bytes → idempotent, still ONE conversion, TWO log rows
  const r2 = await request(app).post('/api/affiliate/postback').set('Content-Type', 'application/json').set('X-MM-Signature', sig).send(body);
  assert.deepStrictEqual(r2.body, r1.body);
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM conversion_records`)).c, 1);
  assert.strictEqual((await db.getAsync(`SELECT COUNT(*) c FROM postback_log`)).c, 2);
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `node --test test/affiliate/e2e.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/affiliate/e2e.test.js
git commit -m "test(affiliate): end-to-end loop incl. resend/dedupe"
```

---

## Task 12: Minimal client trigger (demo page)

**Files:**
- Create: `client/src/components/AffiliateHandoff.js`, `client/src/components/AffiliateDemo.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: Write `client/src/components/AffiliateHandoff.js`**

```jsx
import React, { useState } from 'react';

// Minimal "Place on [Book]" trigger: POST the pick context to /api/affiliate/click,
// then open the returned deep link. (The gated/eligibility CTA is separate, deferred work.)
export default function AffiliateHandoff({ context, label = 'Place on Mock Book' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const go = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/affiliate/click', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context),
      });
      if (!res.ok) throw new Error(`click failed (${res.status})`);
      const { deep_link_url } = await res.json();
      window.open(deep_link_url, '_blank', 'noopener');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <span>
      <button onClick={go} disabled={busy}>{busy ? 'Opening…' : label}</button>
      {error && <span style={{ color: 'var(--live-text)', marginLeft: 8 }}>{error}</span>}
    </span>
  );
}
```

- [ ] **Step 2: Write `client/src/components/AffiliateDemo.js`**

```jsx
import React, { useState } from 'react';
import AffiliateHandoff from './AffiliateHandoff';

// Tiny dev surface to exercise the loop without touching the betting slips.
export default function AffiliateDemo() {
  const [ctx, setCtx] = useState({
    userId: Number(localStorage.getItem('userId')) || 1, book: 'mock_book',
    event_id: 'evo-2026', match_id: 'm-001', market_id: 'mk-sf6-outright',
    selection_id: 'sel-mena', participant_id: 'p-mena', source_page: 'match_detail',
  });
  const set = (k) => (e) => setCtx({ ...ctx, [k]: e.target.value });
  return (
    <div style={{ maxWidth: 640, margin: '40px auto', fontFamily: "'Hanken Grotesk', sans-serif", color: 'var(--text)' }}>
      <h1 style={{ fontFamily: "'Saira', sans-serif" }}>Affiliate handoff demo</h1>
      <p style={{ color: 'var(--muted)' }}>Fires the click → deep-link → mock-book loop.</p>
      {['event_id', 'match_id', 'market_id', 'selection_id', 'participant_id', 'source_page'].map((k) => (
        <label key={k} style={{ display: 'block', margin: '8px 0' }}>
          {k}: <input value={ctx[k]} onChange={set(k)} style={{ width: 320 }} />
        </label>
      ))}
      <AffiliateHandoff context={ctx} />
    </div>
  );
}
```

- [ ] **Step 3: Add the route in `client/src/App.js`**

Add the import near the other component imports:
```js
import AffiliateDemo from './components/AffiliateDemo';
```
Add the route inside `<Routes>` (it's a dev surface — leave it ungated):
```jsx
<Route path="/affiliate-demo" element={<AffiliateDemo />} />
```

- [ ] **Step 4: Manual verification of the whole loop**

Run (separate terminals):
```bash
node server.js                       # :5000 (after migrate-affiliate has run once)
node mock-book/server.js             # :4100
npm --prefix client start            # :3000
```
In the browser: open `http://localhost:3000/affiliate-demo` → click **Place on Mock Book** → a new tab opens the mock book showing the tracking params → click **Confirm bet** → it reports Money Match responded `200 {"received":true}` → click **Resend last postback** → still `200`. Then verify the DB:
```bash
sqlite3 db/database.db "SELECT outcome FROM postback_log ORDER BY id DESC LIMIT 2;"   # reconciled, then duplicate
sqlite3 db/database.db "SELECT click_id,status FROM click_records ORDER BY created_at DESC LIMIT 1;" # converted
sqlite3 db/database.db "SELECT click_id,external_ref,validation_status FROM conversion_records ORDER BY received_at DESC LIMIT 1;" # pending
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/AffiliateHandoff.js client/src/components/AffiliateDemo.js client/src/App.js
git commit -m "feat(affiliate): minimal client demo trigger for the handoff loop"
```

---

## Task 13: Full suite + README

**Files:**
- Create: `mock-book/README.md`

- [ ] **Step 1: Run the entire affiliate + mock-book suite**

Run: `npm run test:affiliate`
Expected: ALL tests pass across `ids`, `hmac`, `window`, `region`, `repo`, `click`, `postback`, `conversions`, `e2e`, and `mock-book/sign`.

- [ ] **Step 2: Write `mock-book/README.md`**

```markdown
# Mock Sportsbook (`:4100`)

Stand-in for a licensed book, to validate Money Match's affiliate attribution loop.

## Run
1. `DATABASE_PATH=./db/database.db node scripts/migrate-affiliate.js` (once)
2. `node server.js`            # Money Match API :5000
3. `node mock-book/server.js`  # mock book :4100
4. `npm --prefix client start` # client :3000 → open /affiliate-demo

## Config
`mock-book/.env` holds `PORT`, `MONEY_MATCH_POSTBACK_URL`, and `MOCK_BOOK_HMAC_SECRET`.
The secret's VALUE must match Money Match's `AFFILIATE_HMAC_SECRET`, but it is configured
independently here — the mock signs, Money Match verifies (two parties, one shared secret).

## What it proves
Deep-link param-carrying + a real cross-origin, HMAC-signed S2S postback that Money Match
verifies, dedupes (idempotent resend), and reconciles against the originating `click_id`.
```

- [ ] **Step 3: Commit**

```bash
git add mock-book/README.md
git commit -m "docs(mock-book): run instructions"
```

---

## Self-review notes (already applied)

- **Spec coverage:** click endpoint (Task 6), postback pipeline + full status matrix & all 12 acceptance behaviors (Task 7, +9/11), three tables (Task 0/5), HMAC verify (Task 2), hold validate/reject + earned predicate (Task 8), mock book landing/confirm/resend (Task 10), client trigger (Task 12). §11 refinements: atomic-insert dedupe (Task 5/7), `timingSafeEqual` (Task 2), raw-bytes-pre-parse (Task 7/9), one-click-many (Task 7), `resolved_at` (Task 0/5/8), inclusive expiry (Task 3), independent secrets (Task 0/10).
- **Type/name consistency:** `repo` exports (`createClick`, `findClick`, `markClickConverted`, `logPostback`, `setPostbackResult`, `insertConversion`, `isUniqueViolation`, `resolveConversion`, `earnedTotal`) are used with those exact names in the router and tests; `signed()` returns `{ body, sig }` in that order (used positionally in one test); uniform ack is `{ received: true }` everywhere.
- **Out of scope (do NOT build here):** geo-routing/eligibility gating, FTP virtual-currency reframe, real books/money, the production gated CTA.
