# Mock Sportsbook (`:4100`)

Stand-in for a licensed book, used to validate Money Match's affiliate attribution
loop (the outbound→inbound handoff) before any real book is wired.

## Run
1. `DATABASE_PATH=./db/database.db node scripts/migrate-affiliate.js`  (once)
2. `node server.js`            # Money Match API :5000
3. `node mock-book/server.js`  # mock book :4100
4. `npm --prefix client start` # client :3000 → open /affiliate-demo

Click **Place on Mock Book** → a new tab opens the mock book showing the tracking
params → **Confirm bet** sends a signed S2S postback (Money Match replies `200
{"received":true}`) → **Resend last postback** demonstrates the idempotent/dedupe
path. Inspect the result:
```
sqlite3 db/database.db "SELECT outcome FROM postback_log ORDER BY id DESC LIMIT 2;"          -- reconciled, then duplicate
sqlite3 db/database.db "SELECT click_id,status FROM click_records ORDER BY created_at DESC LIMIT 1;"  -- converted
sqlite3 db/database.db "SELECT external_ref,validation_status FROM conversion_records ORDER BY received_at DESC LIMIT 1;"  -- pending
```

## Config
`mock-book/.env` holds `PORT`, `MONEY_MATCH_POSTBACK_URL`, and `MOCK_BOOK_HMAC_SECRET`.
The secret's VALUE must match Money Match's `AFFILIATE_HMAC_SECRET`, but it is configured
independently here — the mock signs, Money Match verifies (two parties, one shared secret).

## What it proves
Deep-link param-carrying + a real cross-origin, HMAC-signed S2S postback that Money Match
verifies (constant-time, raw bytes before parse), dedupes (idempotent resend via
`UNIQUE(book, external_ref)`), and reconciles against the originating `click_id`.

## Tests
`npm run test:affiliate` runs the whole loop's `node:test` suite (no third-party test deps).

## Scope
This is the attribution loop only. Geo-routing, eligibility gating, the free-to-play
reframe, real books, and real money are out of scope here — see
`docs/superpowers/specs/2026-06-18-mock-sportsbook-affiliate-design.md`.
