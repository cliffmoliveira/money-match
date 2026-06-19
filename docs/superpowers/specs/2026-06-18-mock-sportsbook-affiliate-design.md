# Mock Sportsbook + Affiliate Attribution Loop — Design Spec

- **Date:** 2026-06-18
- **Status:** Approved design — pre-implementation
- **Source:** `docs/money-match-punchlist-and-affiliate-spec.md` (Part 2)

---

## 1. Goal & scope

**Goal.** Validate Money Match's side of the affiliate-wagering handoff — the
**outbound → inbound attribution loop** — before any real licensed book is wired.
A standalone **mock sportsbook** stands in for a real book so the exact integration
code path (deep-link param-carrying + signed server-to-server conversion postback +
reconciliation) works **unchanged** when a real affiliate program plugs in.

**In scope (this task):** the attribution loop only.
- Outbound: a tracked click → server-minted `click_id` carried in a deep link to the mock book.
- The mock-book landing page that echoes the tracking params it received (the verification window).
- Inbound: a real cross-origin, HMAC-signed S2S conversion postback → verify → dedupe → reconcile against `click_id` + match.
- Persistence/audit: `click_records`, `postback_log`, `conversion_records`.
- The non-negotiables in §7.

**Out of scope** (specced / handled separately):
- Real book integrations; real money.
- The free-to-play virtual-currency reframe (balance/Deposit relabel, community-odds aggregation).
- Geo-**routing** logic (region→book selection, US/UK/non-Ontario exclusions, eligibility gating). We only **capture** `region` on the click for the audit trail; routing here always resolves to the mock book.
- The eligibility-gated production "Place on [Book]" CTA. The client trigger in this task is a minimal button that always starts the loop.

**Product context (why).** Money Match remains the discovery + pick-building layer
and never holds funds or settles bets; real wagering is handed off to a licensed book
via tracked affiliate deep links. The agreed end-state is hybrid (free-to-play
everywhere + affiliate handoff where legal). This task builds and proves the
handoff/attribution backbone in isolation.

---

## 2. Architecture

Two processes plus a thin client trigger:

- **Money Match backend** (existing Express, `:5000`) — gains an **affiliate module**:
  the two endpoints, HMAC verification, and three tables in the existing SQLite DB.
  This is "our end."
- **Mock-book service** (new, standalone Express, `mock-book/`, `:4100`) — the external
  book stand-in: a landing page + a `/confirm` that sends a real signed S2S postback.
  **No shared DB, session, or code module** with the backend; holds its **own copy** of
  the HMAC secret.
- **Client trigger** — a minimal "Place on [Book]" button that calls the click endpoint
  and opens the returned deep link in a new tab.

```
client (:3000) --POST /api/affiliate/click--> backend (:5000)
   |  <--{ click_id, deep_link_url }--           mint click_id (ULID), insert ClickRecord, build deep link
   |  open deep_link_url (new tab)
   v
mock-book (:4100)  /bet  -> echoes params ; "Confirm bet" -> /confirm
   |  real cross-origin, HMAC-signed POST
   v
backend  /api/affiliate/postback -> verify HMAC -> persist raw -> dedupe -> reconcile by click_id
   SQLite: click_records, postback_log, conversion_records
```

**Rationale for a separate service.** The task is to validate the external boundary, so
the boundary is real — a different origin, a true cross-origin S2S call, and no shared
state the mock could cheat through. The same receiver code then works unchanged against
a real program.

---

## 3. End-to-end flow

1. In the client a pick is selected; user taps **"Place on [Book]"**.
2. Client → `POST /api/affiliate/click` with the pick context.
3. Backend mints an unguessable `click_id`, inserts a `ClickRecord` (`status='clicked'`),
   builds `deep_link_url`, returns it.
4. Client opens that URL in a new tab → lands on the **mock book**.
5. Mock-book landing page **displays every tracking param it received** — proof the link carried them.
6. Tester clicks **Confirm bet** → mock book's server builds a conversion payload,
   **HMAC-signs it with its own secret**, and makes a real cross-origin `POST` to `/api/affiliate/postback`.
7. Backend runs the postback pipeline (§4.2) → reconciles the conversion against the click.
8. Conversion is now tied to the exact click → match / page / book / region.

---

## 4. Endpoint contracts

### 4.1 `POST /api/affiliate/click` — mint a tracked click + deep link

**Request** (pick context only — **no `region`, no PII**):
```json
{ "userId": 6, "book": "mock_book", "event_id": "...", "match_id": "...",
  "market_id": "...", "selection_id": "...", "participant_id": "...",
  "source_page": "live" }
```
`source_page ∈ { home, live, futures, match_detail }`.

**Server does:**
1. Validate context (required ids present; `source_page` allowed).
2. **Resolve `region` server-side** — geo-IP of the request; `AFFILIATE_DEV_REGION` fallback on localhost. **Never read region from the request body** (spoofable; meaningless for a compliance audit).
3. Resolve `affiliate_id` from server config (per book; mock uses `MOCK_AFFILIATE_ID`).
4. Generate `click_id` — **ULID** (sortable, unique, unguessable).
5. Build `deep_link_url` = `${MOCK_BOOK_URL}/bet?click_id=…&affiliate_id=…&market=…&selection=…` — **tracking params only**.
6. Insert `ClickRecord` (`status='clicked'`, `created_at=now`).
7. Respond **`201 { click_id, deep_link_url }`**. Bad/missing context → **`400`**.

### 4.2 `POST /api/affiliate/postback` — receive, verify, dedupe, reconcile

Signature = `HMAC-SHA256(rawBody, secret)` in header `X-MM-Signature`. **Pipeline order
is load-bearing:**

1. **Persist raw, always, first.** Append one `postback_log` row (`received_at`,
   `remote_ip`, `signature_valid=null`, `outcome='received'`, `raw_payload` = exact bytes)
   **before any parse or verification**, so nothing is lost — including malformed or forged hits.
2. **Verify HMAC** over the raw body with Money Match's own secret → set `signature_valid`.
   **The signature gate is checked before the body is parsed.** Invalid/missing →
   `outcome='rejected_signature'`, **`401`**, stop (no parse, no reconcile).
3. **Parse body.** Malformed JSON / missing required fields → `outcome='malformed'`, **`400`**, stop.
4. **Dedupe on `(book, external_ref)`** (DB `UNIQUE`). Already exists → `outcome='duplicate'`,
   return the **same idempotent `200` ack** the original returned; create no new conversion, change no state.
5. **Reconcile.** Look up `click_records` by `click_id`. **Expiry is computed from the
   `click_records.created_at` column vs `ATTRIBUTION_WINDOW_DAYS` — never from the ULID's
   embedded timestamp.**
   - Matched & within window → insert `conversion_records` (`validation_status='pending'`,
     FK → `click_id` and `postback_log.id`), set click `status='converted'`,
     `outcome='reconciled'`, **`200`**.
   - Unknown `click_id` → `outcome='unmatched'`, **`200`**, **no** conversion.
   - Expired `click_id` → `outcome='expired'`, **`200`**, **no** conversion.
6. **Hold window.** Conversions start `pending`. Terminal states: **`pending → validated`**
   (hold cleared) or **`pending → rejected`** (bonus abuse / chargeback during hold). The
   **"earned" predicate is `validation_status = 'validated'`** — it excludes both `pending`
   **and** `rejected`. Dev endpoints `POST /api/affiliate/conversions/:id/validate` and
   `.../reject` advance the state so both paths can be exercised.

**Ack body.** Every `200` returns a uniform `{ "received": true }` — the real outcome lives
in `postback_log.outcome`, never in the response body — so a duplicate's ack is
byte-identical to the original's and the book cannot tell a resend from a first delivery
(its retry logic rests). `401` and `400` return a minimal error body.

**Status-code matrix** (principle: HMAC failure is the only gate-level error; a malformed
signed body is a `400`; everything else legitimately sent gets a `200`-style received with
the real outcome in the internal `outcome` field, so the book's retry logic rests):

| Case | HTTP | `postback_log.outcome` | Conversion |
|---|---|---|---|
| Missing/invalid signature | **401** | `rejected_signature` | none |
| Valid + malformed body | **400** | `malformed` | none |
| Valid + duplicate `(book,external_ref)` | **200** (idempotent) | `duplicate` | none new |
| Valid + unmatched `click_id` | **200** | `unmatched` | none |
| Valid + expired `click_id` | **200** | `expired` | none |
| Valid + matched, in window | **200** | `reconciled` | one, `pending` |

### 4.3 Mock-book endpoints (`:4100`)
- `GET /bet` — landing page; reads query params and **renders every received tracking
  param** (`click_id`, `affiliate_id`, market/selection/event identifiers) + a "Confirm bet" form.
- `POST /confirm` — builds the conversion payload (`book='mock_book'`, fresh unique
  `external_ref`, `conversion_type`, `amount`, `currency`, `click_id` from the landing),
  **HMAC-signs the raw body with its own secret**, makes the real cross-origin POST to
  `MONEY_MATCH_POSTBACK_URL`, and shows the response.

---

## 5. Data model (SQLite, via the existing `db` layer)

```sql
-- 1) Every minted click. created_at drives the 30-day window + click→convert latency.
click_records (
  click_id      TEXT PRIMARY KEY,            -- ULID, unguessable
  user_id       INTEGER,                     -- FTP user; no PII
  region        TEXT,                        -- resolved SERVER-side at click time
  book          TEXT,
  affiliate_id  TEXT,
  event_id TEXT, match_id TEXT, market_id TEXT, selection_id TEXT, participant_id TEXT,
  source_page   TEXT,                        -- home|live|futures|match_detail
  deep_link_url TEXT,
  status        TEXT DEFAULT 'clicked',      -- clicked | converted | expired
  created_at    TEXT                         -- ISO-UTC; SOLE source for expiry math
)  -- idx: (book), (status), (created_at)

-- 2) Append-only receipt of EVERY inbound postback (incl. invalid/unmatched/duplicate).
postback_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at     TEXT,
  remote_ip       TEXT,                      -- for IP-allowlist / audit (see §9)
  signature_valid INTEGER,                   -- null → set once after verify
  book TEXT, external_ref TEXT, click_id TEXT,   -- best-effort parsed, for querying
  outcome         TEXT,                      -- received|rejected_signature|malformed|
                                             --   duplicate|unmatched|expired|reconciled
  raw_payload     TEXT                       -- exact bytes, immutable
)  -- idx: (received_at), (click_id), (book, external_ref)

-- 3) Reconciled business records (one per book+external_ref). Status-updated.
conversion_records (
  conversion_id     TEXT PRIMARY KEY,        -- ULID
  postback_log_id   INTEGER REFERENCES postback_log(id),     -- lineage to the raw hit
  click_id          TEXT REFERENCES click_records(click_id), -- the join key
  book TEXT, external_ref TEXT,
  conversion_type   TEXT,                    -- registration|first_time_deposit|bet_placed
  amount            INTEGER,                 -- MINOR UNITS (e.g. cents); never a float
  currency          TEXT NOT NULL,           -- ISO 4217; always required
  commission_model  TEXT,                    -- cpa | revshare
  commission_value  INTEGER,                 -- minor units
  validation_status TEXT DEFAULT 'pending',  -- pending | validated | rejected (terminal: validated|rejected)
  received_at TEXT,
  resolved_at TEXT,                          -- set when leaving 'pending' (validated OR rejected)
  UNIQUE (book, external_ref)                -- DB-level idempotent dedupe
)  -- idx: (click_id), (validation_status)
```

Notes:
- `signature_valid` + `raw_payload` live on `postback_log` (the conversion only exists when valid).
- `UNIQUE(book, external_ref)` enforces dedupe atomically: insert; on violation → fetch existing → return its idempotent ack.
- **`amount` and `commission_value` are integer minor units** (e.g. cents); **`currency` is `NOT NULL`** (ISO 4217). No floating-point money.
- **Expiry uses the `created_at` column only** — not the timestamp embedded in the ULID.
- `earned = (validation_status = 'validated')`. Revenue reporting sums validated only; `pending` and `rejected` are excluded.

---

## 6. Config & secrets (two services, secret held independently)

- **Money Match `.env`:** `AFFILIATE_HMAC_SECRET`, `MOCK_BOOK_URL=http://localhost:4100`,
  `MOCK_AFFILIATE_ID`, `AFFILIATE_DEV_REGION=BR`, `ATTRIBUTION_WINDOW_DAYS=30`.
- **Mock-book `.env`:** `MONEY_MATCH_POSTBACK_URL=http://localhost:5000/api/affiliate/postback`,
  `MOCK_BOOK_HMAC_SECRET`, `PORT=4100`.
- The two secrets carry the **same value, configured independently** — never imported from a
  shared code module. This mirrors "two parties holding a shared secret," so the path is
  identical when a real program supplies the secret.

---

## 7. Non-negotiables (acceptance criteria)

1. `click_id` globally unique, unguessable, generated at click time — never reused or sequential.
2. Idempotent dedupe on `(book, external_ref)` — books resend; never double-count.
3. Verify postbacks via HMAC shared secret (signature gate before body parse).
4. Always persist `raw_payload` for every inbound hit, before verification.
5. `validation_status` hold window — conversions start `pending`; only `validated` counts as earned.
6. No PII in URLs; deep links carry tracking params only.
7. `region` resolved server-side; never client-supplied.
8. Money amounts in integer minor units; `currency` always present.
9. Expiry computed from `created_at`, not the ULID timestamp.

---

## 8. Testing (TDD — non-negotiables become the suite)

Backend module tests run against a temp SQLite DB; mock-book has its own signing test.

1. `click` → ULID `click_id`; `region` server-resolved (ignored if present in body); deep link has tracking params and **no PII**.
2. Valid sig + matched click → one `ConversionRecord(pending)`, click→`converted`, log `reconciled`, **200**.
3. Invalid sig → **401**, logged `signature_valid=0`/`rejected_signature`, no conversion, no click change.
4. **Raw-before-verify:** a forged payload still lands in `postback_log`.
5. Duplicate `(book,external_ref)` → idempotent **200** same ack; exactly **one** conversion; **two** `postback_log` rows.
6. Unmatched `click_id` → **200**, `unmatched`, no conversion.
7. Expired `click_id` (`created_at` older than window) → **200**, `expired`, no conversion.
8. Signed-but-malformed body → **400**, `malformed`, no conversion.
9. **Precedence:** invalid-signature **and** malformed body → **401** (signature gate runs before body parse).
10. Hold: conversion starts `pending`; `validate` → `validated` (earned); `reject` → `rejected` (not earned); revenue report excludes both `pending` and `rejected`.
11. Expiry math reads the `created_at` column (a row whose ULID time differs from a tampered `created_at` honors the column).
12. Mock-book `/confirm` emits a payload whose signature **verifies** under the shared secret.

---

## 9. Error handling, edge cases & security notes

- **Raw before verify/parse** — survives a crash mid-pipeline.
- **DB `UNIQUE` violation = the dedupe path**, not an error.
- **Timestamps ISO-UTC**; window computed in UTC; **from the `created_at` column**.
- **`pending`/`rejected` never summed as earned.**
- **`remote_ip` / proxies:** IP-allowlisting is only trustworthy once the **real client IP is
  resolved correctly behind any proxy/load balancer** (e.g. Express `trust proxy` +
  `X-Forwarded-For` handling). Until then, treat `remote_ip` as audit-only and do not gate on
  it. In local dev it is loopback; document the proxy-aware resolution requirement before any
  allowlist enforcement.
- **Money** in integer minor units; `currency` required; no floats.
- **No PII in deep links or logs** beyond internal ids.

---

## 10. Deferred / future (not this task)

- Geo-**routing** config `(region, title) → book + deep-link template + tracking`, with hard
  US/UK/non-Ontario-Canada exclusions and eligibility gating (no Smash; SF6/Tekken only;
  Top-8/seeded + adult-verified).
- Free-to-play virtual-currency reframe + community-odds aggregation (Part 3).
- Real affiliate program onboarding (GG.bet, Thunderpick, Rivalry, Pinnacle); S2S postback
  formats per program; odds-feed display; multi-book best-price routing.
- The production eligibility-gated "Place on [Book]" CTA replacing the minimal trigger.

---

## 11. Implementation refinements (binding on the plan)

These tighten §4–§9 and are binding on the implementation:

1. **Dedupe = the atomic insert, not a pre-SELECT.** Reconcile by *attempting* the
   `conversion_records` insert and catching the `UNIQUE(book, external_ref)` violation as the
   duplicate path. No `SELECT`-then-`INSERT` (which would race under concurrent resends).
2. **Constant-time HMAC compare.** Verify with `crypto.timingSafeEqual` over equal-length
   digests — never `===`.
3. **HMAC over exact received bytes.** Capture the raw body *before* JSON parsing (via the
   `express.json` `verify` callback or an `express.raw` body) so the signature is checked
   against precisely what the book sent — parsing must not alter what was signed.
4. **One click → many conversions is valid.** A click may yield registration, then
   first-time-deposit, then bet-placed (distinct `external_ref`s). Never add a guard that
   blocks a new conversion because the click is already `converted`; dedupe is on
   `(book, external_ref)` only.
5. **Mock "Resend last postback".** The mock retains the exact last signed payload and
   re-posts the identical bytes on demand, so the idempotency/dedupe path is demonstrable
   through the UI, not only in unit tests.
6. **`resolved_at` for terminal states.** `conversion_records.resolved_at` is set when a
   conversion leaves `pending` for either `validated` or `rejected` (replaces `validated_at`);
   `validation_status` records which.
7. **Expiry boundary is inclusive.** In-window ⇔ `received_at − created_at ≤ ATTRIBUTION_WINDOW`
   (a postback landing exactly at `created_at + window` is still in-window); strictly beyond is
   `expired`. Computed from the `created_at` column. Include a boundary-exact test.

---

*Reflects a product/engineering design, not legal advice. Confirm licensing, jurisdiction,
age-rule, and disclosure specifics with qualified gaming counsel before any real-money or
public launch.*
