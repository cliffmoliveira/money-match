# Money Match — Punch List & Affiliate Wagering Integration Spec

A handoff doc for the build team. Part 1 is a prioritized fix list from a review of Home, Live, Futures, and Results. Part 2 is the spec for layering affiliate links to licensed sportsbooks so the product can offer real wagering without becoming a licensed operator.

---

## Part 1 — Fix Punch List

### P0 — Data integrity / blockers (fix before anyone external sees it)

1. **`0-0` settled-set bug (systemic).** Settled matches are rendering with a `0-0` deciding score (seen on Home "Recent Champions" and in Results, e.g. Genesis Saturday Deluxe / Tekken 8). A settled FGC set can never be 0-0, and this audience reads set scores closely — it instantly looks broken. Trace it in the results parser/data source, not just the display layer, since it appears in multiple places.
2. **"Unknown Location" on every Results row.** The location field isn't being populated anywhere in the Results table. Either backfill location data or hide the column until it's reliable.
3. **Futures cold-load hang.** `/future-tournaments` sits on "Loading future tournaments…" for several seconds before rendering. Add a loading skeleton and cache/prefetch the tournament list so first paint isn't a blank/slow state.

### P1 — Strategic alignment (decides product direction)

4. **Lock the model: free-to-play vs real-money.** The current "Deposit / balance / internal settlement" pattern implies an operator product. Decide explicitly:
   - *Free-to-play / social:* relabel balance as virtual currency, make "Deposit" a virtual top-up, no cash custody. Low regulatory burden, near launch-ready.
   - *Real-money:* the "Deposit" button cannot go live without a gambling license in each market served. (See Part 2 for the recommended hybrid: free-to-play UI + affiliate handoff for real wagering.)
5. **Remove Super Smash Bros. from the betting surface.** Keep it as content/audience only. It is the worst-fit title for wagering: youngest competitive scene (minors at the top), no coverage by licensed esports books, and Nintendo's restrictive stance toward Smash esports. It should never appear as a bettable market.
6. **Trim the bettable title list to where liquidity exists.** Street Fighter 6 and Tekken 8 are the realistic betting titles. The long tail (Vampire Savior, Under Night, BlazBlue, Invincible Vs., Granblue, etc.) is great for content/SEO but has no book coverage or liquidity — don't expose them as markets, or they'll show empty/odds-less.
7. **Age/eligibility gating on markets.** Keep the existing Top-8 (live) and seeded-bracket (futures) gating — it's good and aligns with surfacing verified-adult pro stages. Additionally: exclude open/community brackets (e.g. "CEO 2026 Community Tournaments") and any match with a sub-18 participant from betting markets entirely. Pro top-8/finals only on the wagering surface.

### P2 — Pre-launch polish / hygiene

8. **License or replace official logos.** Game and tournament logos (Super Smash Bros. Ultimate, Tekken 8, event marks) are trademarked IP. Fine for a prototype; clear or replace before any public, money-touching launch.
9. **Loading skeletons site-wide.** Empty states are already good; add skeletons on every data-fetch page to match.
10. **Affiliate disclosure + 18+/responsible-gambling messaging + geo-routing.** Required wherever a betting handoff exists. Details in Part 2.

---

## Part 2 — Affiliate Wagering Integration Spec

### Model

Money Match remains the **discovery + pick-building layer**. It does not take wagers, hold player funds, or settle bets. At the moment a user wants real money down, it hands them off to a **licensed sportsbook** via a tracked affiliate deep link. The book performs the regulated functions (account creation, KYC, deposit, bet acceptance, settlement, payout). Money Match earns CPA or revenue share on referred players.

This keeps Money Match out of operator licensing while still monetizing real wagering.

### Recommended product shape (hybrid)

- **Free-to-play layer** (everywhere): virtual-currency picks, leaderboards, P&L for engagement. Builds the audience and works in every jurisdiction.
- **Affiliate wagering layer** (where legal): a "Bet on [Book]" handoff shown only to eligible users in eligible regions.

### The seamless handoff flow

1. User builds selections in the existing slip UI ("Live Slip" / "Your Slip").
2. User taps **"Place on [Book]"**.
3. App resolves the right book for the user's region + title, constructs a deep link to the exact market with tracking attached, and opens it.
4. User lands one step from confirming, logs in / signs up at the book, and places the bet on the book's side.

Compress every step before step 4 to near zero. Step 4 itself (account + deposit + confirm at the book) is legally required and cannot be removed.

### Implementation steps

1. **Join affiliate programs.** Start with GG.bet (in-house program, ~40–60% RevShare / $60–150 CPA, 30-day cookie) and Thunderpick (esports-first, crypto). Add Rivalry for a more regulated/AGCO-capable partner. Obtain each program's tracking parameters and deep-link format.
2. **Build a book-routing config.** A table mapping `(user_region, title) -> book + deep-link template + tracking params`. This is the heart of the system; keep it data-driven so books/regions can be added without code changes.
3. **Deep links, not homepages.** For each market, build a link to the specific event/outright (e.g. SF6 Evo 2026 outright) rather than the book's front page. Append affiliate ID + a per-click sub-ID you generate.
4. **Geo-detection.** Use geo-IP to determine the user's region on each handoff. If no eligible book covers `(region, title)`, suppress the betting CTA and show the free-to-play / content path instead.
5. **Attribution.** Generate a unique sub-ID/clickID per click so you can map conversions back to the exact match/page that drove them. Wire server-to-server (S2S) postbacks where the program supports it for accurate CPA/RevShare reconciliation.
6. **Multi-book + odds comparison (phase 2).** Pull odds from 2–3 books and route by region + coverage + best price. Surface "best price across books" as a feature; it improves both conversion and content value.

### Geo-routing & eligibility rules

- Route only to a book that is licensed/available in the user's region **and** covers the title.
- Hard-exclude regions where promoting these books is a legal problem (e.g. US — promoting offshore/unlicensed books to US users is illegal; Ontario unless using an AGCO-registered partner). Those users get the free-to-play / content experience, never a betting handoff.
- Apply the same age/eligibility gating as the markets: no handoff on open-bracket or sub-18 matches.

### Compliance & disclosure (required wherever a handoff exists)

- Clear affiliate disclosure on betting links.
- 18+/21+ labeling per region and responsible-gambling messaging + links.
- Respect each program's allowed-GEO rules and brand-bidding restrictions (e.g. GG.bet prohibits bidding on its brand terms without consent).
- Get a gaming attorney to confirm the per-jurisdiction handoff rules before public launch — especially the age rule (event-level vs match-level) and the US/Ontario exclusions.

### What "seamless" can and cannot include

- **Can:** pre-resolve the right book, deep-link to the exact market, pre-identify the selection where the book's deep-link/API supports it, carry tracking invisibly, one-tap handoff.
- **Cannot:** auto-place the user's wager inside the book or bypass the book's account/KYC/deposit step. The book must legally onboard and verify the user itself. The flow always ends with the user confirming on the book's side.

### Odds, bet data & what you can track

A key boundary to design around: **"maintaining odds" is bookmaker work, and in the affiliate model the book does it — not Money Match.** Moving lines based on incoming money is exactly the operator function the affiliate model exists to offload (along with its liability and licensing).

What this means concretely:

- **You do not set or move real-money odds.** The licensed book makes the market and manages its own risk.
- **You cannot see the book's bets.** Once a user wagers at the book, that bet lives in the book's system. Affiliate reporting exposes only *your* slice — clicks, signups, first-time deposits, and aggregate turnover/revenue from *your referred players* — never the market-wide distribution ("what share of money is on player X") needed to price odds. No affiliate feed exposes that; it's the operator's proprietary data.
- Wanting to track every bet and move your own lines off live flow **is running a sportsbook** — the operator/licensed path. It can't be obtained through an affiliate relationship.

What you **can** own and track:

1. **Free-to-play picks are fully your data.** Every virtual-currency pick made *inside Money Match* is visible to you — who's picked, how often, by how many users. Build a community-consensus layer and display *implied community odds* from your own users' behavior. (Sentiment, not a real book — but it's yours. See Part 3.)
2. **Display real odds without making them.** Pull books' lines via an odds feed/aggregator and show or compare them. You're a price *displayer*, not a price *maker* — content, not bookmaking.
3. **Affiliate analytics** show which matches/pages convert, so you can optimize content without seeing individual bets.

Keep the two lanes separate: free-to-play picks = full visibility (your data); real wagering = the book's odds and the book's bet data, which you neither control nor see.

### Book-routing config (starter)

Implement as a data-driven table: `(region, title) -> book + deep-link template + tracking`. Add books/regions via data, not code.

| Region | Primary book | Fallback | Bettable titles | Eligibility notes |
|---|---|---|---|---|
| Brazil | GG.bet | Thunderpick (crypto) | SF6, Tekken 8 | Huge FGC scene; serve pt-BR. Confirm current legality. |
| Mexico | GG.bet | Thunderpick | SF6, Tekken 8 | es-MX. |
| LatAm (AR, CL, CO, PE) | GG.bet | Thunderpick | SF6, Tekken 8 | Confirm per-country; some restrict. |
| SE Asia (PH, ID, TH) | GG.bet | Thunderpick | SF6, Tekken 8 | Confirm per-country; several restrict online betting. |
| Canada — Ontario | **Rivalry only** | — | SF6, Tekken 8 | Only an AGCO-registered partner is legal for ON traffic. |
| Canada — other provinces | Rivalry | GG.bet | SF6, Tekken 8 | Grey/tolerated; Rivalry (Isle of Man) cleanest. |
| Europe (regulated, non-UK) | Pinnacle | GG.bet | SF6, Tekken 8 | Many EU markets need local licenses; Curaçao books may be geo-blocked — confirm per country. Lower priority (competitive). |
| **United States** | **— (no handoff)** | — | — | **Excluded.** Free-to-play / content only. Promoting offshore books to US users is illegal. |
| **United Kingdom** | **— (no handoff)** | — | — | **Excluded** unless you hold a UK-licensed partner; Thunderpick doesn't serve UK and UKGC affiliate rules are strict. FTP/content only. |

**Deep-link templates** (illustrative — confirm exact paths/params in each program's dashboard; not every book exposes per-event links, so fall back to the title/esports landing page with tracking attached):

- GG.bet: `https://gg.bet/{locale}/betting/{title-slug}/{event-slug}?btag={AFFILIATE_ID}_{CLICK_ID}`
- Thunderpick: `https://thunderpick.io/{locale}/esports/{title}?r={AFFILIATE_ID}&sub={CLICK_ID}` (crypto deposits)
- Rivalry: `https://www.rivalry.com/{locale}/match/{event}?ref={AFFILIATE_ID}&sub={CLICK_ID}`
- Pinnacle: build via their affiliate network's deep-link generator.

**Two rules to bake in:**

1. Every link carries a per-click `CLICK_ID` (sub-ID) so conversions attribute back to the exact match/page.
2. The **US / UK / non-Ontario-Canada exclusions are hard-coded.** If `(region, title)` has no eligible book, suppress the betting CTA and show the free-to-play path instead.

---

## Part 3 — Free-to-Play "Community Odds" Data Model

This is the data you actually own. Users make virtual-currency picks inside Money Match; you aggregate them into a community-sentiment view and display implied community odds. Sentiment only — not a priced book — but a genuine, ownable engagement asset.

### Core entities (sketch)

```
Event        { id, name, game, location, start_at, status }            // e.g. Evo 2026 / SF6
Participant  { id, event_id, handle, seed, is_adult_verified }         // gates eligibility
Market       { id, event_id, type, status, opens_at }                  // outright | match | top8; status: locked|open|settled
Selection    { id, market_id, participant_id }                         // a pickable option
Pick         { id, user_id, selection_id, stake_virtual, created_at }  // one user's FTP pick
User         { id, region, virtual_balance, created_at }
```

### Deriving community odds (from your own picks)

For an open market, aggregate `Pick` rows by `selection_id`:

```
selection_volume   = SUM(stake_virtual) for that selection
market_volume      = SUM(stake_virtual) across the market
community_share    = selection_volume / market_volume        // 0..1 = implied probability
implied_odds_dec   = 1 / community_share                      // display as decimal odds
```

Display as "Community: 62% backing MenaRD" and/or implied decimal odds. Recompute on a short interval (cache it) rather than per request.

### Guardrails to build in

- **Eligibility carries through:** only generate Selections for `is_adult_verified` participants, and only on Top-8 / seeded markets — same gating as the real-wagering surface. Open-bracket and sub-18 participants are content-only, never pickable.
- **Label it as sentiment, not a price you stand behind** — community implied odds ≠ a real book's odds. Keep the wording clear so users don't read it as a wager you're booking.
- **Keep it strictly virtual.** No cash in, no cash out on this layer — that's what keeps it free-to-play and out of gambling licensing. Real money only ever happens via the affiliate handoff to a licensed book.
- **This data is your moat.** Pick distribution, most-backed players, and conversion-by-match are insights no affiliate feed gives you — use them to drive content, surface "people's champion" storylines, and decide which matches to push during event windows.

---

## Part 4 — Attribution & Handoff Validation (Engineering)

### Scope of the first validation

Validate **our** side of the handoff loop — deep-link param-carrying and round-trip attribution — with minimal mock UI. Build a mock-book page (not a full journey simulation, not API-only):

- Lands from the deep link.
- Displays every tracking param received (`affiliate_id`, `click_id`, resolved market, selection) to prove the link carried them.
- Exposes a "Confirm bet" action that fires a server-to-server conversion postback to a Money Match attribution endpoint.
- The postback reconciles the conversion against the originating `click_id` and match — not just "a conversion."

Out of scope for this task: real book integration, real money, the FTP virtual-currency layer, and geo-routing (specced separately).

### Data model — two tables joined by `click_id`

```
ClickRecord {
  click_id        // PK — unique, unguessable (UUID/ULID); goes in the deep link
  user_id         // internal FTP user; no PII
  region          // geo at click time (compliance audit + routing)
  book            // gg_bet | thunderpick | rivalry | pinnacle
  affiliate_id
  event_id, match_id, market_id, selection_id, participant_id
  source_page     // home | live | futures | match_detail
  deep_link_url   // full constructed URL (debug: did params survive?)
  status          // clicked | converted | expired
  created_at
}

ConversionRecord {
  conversion_id     // PK
  click_id          // FK -> ClickRecord — THE join key
  book
  conversion_type   // registration | first_time_deposit | bet_placed
  amount, currency
  commission_model  // cpa | revshare
  commission_value
  external_ref      // book's player/transaction ID
  signature_valid   // HMAC verified?
  validation_status // pending | validated | rejected
  raw_payload       // store the entire raw postback always
  received_at
}
```

**Reconciliation:** postback arrives with `click_id` -> look up ClickRecord -> attach ConversionRecord -> set click `status = converted`. Every conversion is then tied to the exact match, page, book, and region that produced it.

### Non-negotiables (or attribution silently breaks)

1. `click_id` globally unique, unguessable, generated at click time — never reused or sequential.
2. Idempotent dedupe on `(book + external_ref)` — books resend postbacks; never double-count.
3. Verify postbacks via HMAC shared secret (or IP allowlist) — build/test on the mock so the path exists before a real program plugs in.
4. Always persist `raw_payload` — every program's format differs.
5. `validation_status` hold window — conversions start `pending`, count as revenue only after the hold clears (bonus abuse / chargebacks). Never report `pending` as earned.
6. No PII in URLs; keep deep links to tracking params only. Store both `created_at` and `received_at` to measure click->convert latency and enforce a 30-day attribution window.

---

*Note: this reflects a product/market review, not legal advice. Confirm licensing, jurisdiction, age-rule, and disclosure specifics with qualified gaming counsel before any real-money or public launch.*
