# MoneyMatch — Session Handoff (2026-06-14 → 06-15)

A resume point for a fresh session. Covers what was built, current state, how to run, and open items.

**Status (2026-06-15):** everything below is **committed and pushed** to `past-results-startgg-backfill` → [PR #1](https://github.com/cliffmoliveira/money-match/pull/1). `node_modules` and the dev DBs are no longer tracked, so `git status` is clean. The latest pass (home page, live-event readiness, clean launch slate) is **§2c**.

## Project at a glance
- **App:** MoneyMatch — bet on competitive fighting-game tournaments (Evo, CEO, etc.).
- **Stack:** React client in `client/` (CRA, react-app-rewired) + Express/SQLite backend in `server.js`. DB at `db/database.db` (path via `DATABASE_PATH` env, set in `.env`). Start.gg GraphQL via `startggClient.js` (`STARTGG_API_TOKEN` in `.env`).
- **Branch:** `past-results-startgg-backfill`, **committed + pushed to [PR #1](https://github.com/cliffmoliveira/money-match/pull/1)** (→ `main`). `node_modules` and the binary dev DBs are now untracked (already in `.gitignore`, just stopped being tracked), so `git status` is clean.
- **Server:** was left running on `:5000` with `ENABLE_DEMO=1` as a background process started from the tool shell — **it may not survive the session ending; just restart it (below).**

## How to run
```powershell
# backend (serves client/build statically + the API). Demo tools need the flag.
$env:ENABLE_DEMO='1'; npm start        # http://localhost:5000
# rebuild the client after frontend changes:
cd client; npm run build
```
- `npm run dev` uses nodemon (auto-restart). Drop `ENABLE_DEMO` for a "production" start (demo tools disappear, demo endpoints return 403).
- `DISABLE_SYNC=1` skips the Start.gg schedulers (used during testing).
- Test harness pattern used all session: copy `db/database.db` → `db/database.test.db`, run a second server via `DATABASE_PATH=./db/database.test.db PORT=5050 DISABLE_SYNC=1 node server.js`, exercise, delete the copy. Keeps the real DB untouched.

## What was built this session

### 1. Future Tournaments — bet slip + transparent seed-based futures
- Replaced the old blur-to-commit inline betting with a **bet slip** (`+Add` / `Adjust` / `Added` per player, "Place Bets" loops `POST /api/bets`). Adjusting a bet **blends the delta** — the server stores a weighted-average `locked_odds` so adding stake only re-prices the *added* portion (`server.js` POST `/api/bets`).
- **Futures are now transparent + seed-based:** each player shows **Seed #**, **Win %** (implied from Start.gg seeding), and **fixed odds**. Top **16 seeds + a "Field"** row. Odds no longer drift parimutuel-style — they're fixed from the seed model (`POST /api/bets` no longer recalculates).
- **Gate:** futures only open for events **within 21 days** (`FUTURES_WINDOW_DAYS`) **and** with a real low seed present (`SEED_SANITY_MAX=4`). Far-future events (e.g. seeding not done) show a **countdown timer** + "Futures open once seeded" instead.
- **Countdown:** segmented `Days:Hrs:Min:Sec`, white-on-green, self-ticking (`Countdown` component owns its own 1s interval).
- **Fetch fix (important):** `sync-upcoming.js` now pulls the **entry phase's `seeds` connection** (seed-ordered) via `pickTopSeeds`, not the unsorted entrants list — so it gets the *real* top seeds (validated live: Evo 2026 → #1 MenaRD, #2 Punk, #3 xiaohai). Self-cleans a game's prior futures (no-bet rows) before repopulating so re-syncs don't duplicate.
- Logo glitch fixed by hoisting `GameTitle`/`TournamentLogo` to module scope.

### 2. Live per-set betting + Top 8 bracket (the big feature)
- **Wallet** (`wallet.js`): ledger-based play money — `wallet_transactions` (append-only) + `users.balance_cents`, integer cents, serialized atomic credit/debit, $1000 signup grant.
- **Odds** (`liveOdds.js`): per-set = seed-seeded *subsidized parimutuel* (`openingProbabilities`, `computeLiveOdds`). Futures = N-way `fieldProbabilities` (rank-based `1/seed` + harmonic Field tail to seed 64; deliberately ignores entrant count).
- **Markets** (`liveMarkets.js`): `set_markets` + `set_bets` lifecycle (open→closed→settled/void), `placeBet`, `settleMarket` (with scores), `fillBracketSlot` (half-filled "pending" nodes so a winner appears immediately with a TBD opponent), plus demo helpers `seedDemoMarkets` / `advanceDemoBracket` / `clearDemoMarkets`.
- **Poller** (`scripts/sync-live.js`): Start.gg live feed — Top 8 = the phaseGroup containing the Grand Final; creates/closes/settles markets; runs every ~60s for active tournaments.
- **Endpoints** (`server.js`): `/api/wallet`, `/api/live/markets`, `/api/live/bets` (GET/POST), `/api/live/sync`, `/api/config`, and demo-gated `/api/live/seed-demo`, `/api/live/demo/{close,settle,reset}` (require `ENABLE_DEMO=1`).
- **Frontend:** `client/src/components/LiveBetting.js` + `Bracket.js` (+ CSS). Route `/live` (`App.js`), navbar link + **wallet badge** (`Navbar.js`).
- **Bracket UX:** EVO-style Top 8; **auto-scales to fit** (CSS transform + `ResizeObserver`, hysteresis + `scrollbar-gutter: stable` in `index.css` to stop a resize "shake"); **SVG connectors** aim at the player-rows center and the Grand Final node is nudged onto its feeder midpoint; winners **advance immediately** (pending nodes); **Live Slip + My Bets** combined into one compact card (`.live-rail`).

### 2b. Live betting — economics rework + reliability (later 2026-06-14)
Follow-up pass on the live-betting feature. **(Committed — see §2c.)**

**Correctness/reliability fixes**
- **Grand Final winners-side bump was being dropped in live play.** `fillBracketSlot` prices a node only when its *second* slot fills; it now derives the winners-side flag from `round_text` instead of a per-call arg, so the 1.15× GF edge actually applies. Removed the misleading `p1WinnersSide` param from the poller/demo callers (`liveMarkets.js`, `scripts/sync-live.js`).
- **Poller Top-8 detection now targets the finals phase.** `scripts/sync-live.js` resolves each event's **final phase** (highest `phaseOrder`) and pulls only that phase's sets (paginated, `filters: { phaseIds }`) instead of the first 64 sets of the whole event — so the Grand Final isn't buried under thousands of pools sets. `selectTop8Sets` keeps the GF-group whole but falls back to canonical round-text if a group is unexpectedly large (single-phase events). Validated live against all 16 Evo 2025 events. `fetchActiveEvents`/`selectTop8Sets` are now exported (handy for manual checks).

**Settlement is now true parimutuel with a provably-solvent house** (this replaced the original `stake × locked_odds` payout, which let the house lose unbounded money):
- **Scaled subsidy** (`liveOdds.js` → `effectiveSubsidyCents(pool)`): subsidy = **25% of the live pool**, floored **$10**, ceilinged **$200** (`SEED_K_CENTS`). Thin pools → tiny house exposure; deep pools → subsidy fades toward pure parimutuel. Replaces the flat $200.
- **Rake-funded cap** (`liveMarkets.js` → `houseBankrollCents()` + `sideRates()`): the house bankroll = cumulative rake kept − payouts made (derived from `set_bets`) + `HOUSE_PROMO_SEED_CENTS`. Each side's price is clamped into `[strict pool split, strict + subsidy the bankroll can fund]`. Guarantees: **(a) the platform is never net-negative** (subsidy only ever spends rake already earned), and **(b) a winner is never paid less than a pure pool split**. `recomputeOdds` (display) and `settleMarket` (payout) use the *same* capped price, so the bettor sees what they'd actually be paid.
- **Tunable knobs:** `SUBSIDY_FLOOR_CENTS` / `SUBSIDY_POOL_FRACTION` / `SEED_K_CENTS` (`liveOdds.js`) tune juice; `HOUSE_PROMO_SEED_CENTS` (`liveMarkets.js`, default **0** = hard "house never loses") funds juicier odds before rake accumulates, at a bounded marketing cost.
- **Why parimutuel + cap (vs strict / fixed-subsidy):** a 50k-market Monte Carlo showed all models net positive, but fixed-$200 lost on 24% of markets (worst −$137), scaled lost on 14% (worst −$92), and strict never lost (hold ≈ rake). The cap gives strict's zero-loss guarantee *with* scaled's juicy odds.

**Bettor transparency** (the parimutuel model is now visible at the point of betting): `Bracket.js` shows a **pool-split bar + money wagered per side** on every live/closed node; the bet slip (`LiveBetting.js`) shows each pick's pool and an explainer that odds are parimutuel/projected, finalized from the pool at set start, and that every payout is fully covered (+ CSS in both component stylesheets).

**Verification:** done via throwaway DB copies (`DATABASE_PATH=./db/database.test.db DISABLE_SYNC=1`) exercising the real `placeBet`/`settleMarket` — confirmed bankroll ≥ 0 after every settle, winners ≥ pool split, GF bump applied; poller validated against the live Start.gg API. (All test scripts were temporary and deleted.) `client` builds clean.

### 2c. Home page + live-event readiness + clean slate (2026-06-15)
All committed/pushed to PR #1. Each item below was eyeballed in a live preview (server against a test/replay DB copy).

- **Home page rebuilt around live betting** (`Home.{js,css}`): a **🔴 Live Now hero** (in-progress sets + odds + balance + CTA to `/live`; with logged-in-idle and logged-out value-prop variants); **unified Your Bets** merging live + futures (WON/LOST/PENDING + sign-correct net, pending first); inline logos hoisted to module scope. A `My Bets` sign bug — a parimutuel "won" pick can net negative, which rendered `+$-2.00` — was fixed (`signed()` helper).
- **Shared `Countdown` component**: extracted from `FutureTournaments.js` into `client/src/components/Countdown.{js,css}` (with a `compact` variant) and reused on Home's Next Up cards. FutureTournaments now imports it.
- **Replay + simulation harness** (`scripts/replay-live.js`): replays a *completed* event's Top 8 through state 1→2→3 on a DB copy with simulated users betting — exercising market open/close/settle, winnerId→player mapping, **Grand Final Reset**, and the parimutuel/cap economics. Validated against Evo 2025 TEKKEN 8 (incl. a real reset): all settled, winners correct, bankroll never negative, money conserved to the cent. Run: `node scripts/replay-live.js [startggId] [gameSubstr]` (leaves `db/database.replay.db`; delete after).
- **Grand Final Reset render fix** (`Bracket.js`): a column now renders every market it holds (`Math.max(col.cap, nodes.length)`), not just `cap` cells — so the Reset (which classifies to GF alongside the Grand Final) actually shows. Verified on real reset data.
- **Date off-by-one fix**: `YYYY-MM-DD` was parsed as UTC midnight → labels showed a day early in west-of-UTC zones. Now `+ 'T00:00:00'` (local) in Home, Future Tournaments, Past Results.
- **Evo France 2026** (Oct 9–11, Nice/FR) added — a manual `tournaments` row (id 204) since the real event isn't on Start.gg yet; the daily sync reconciles when it registers (watch for a possible duplicate then).
- **Economics at scale** (Monte Carlo on the real odds engine, 50–100 users × 600 events): house **hold settles at ~4.3–4.7%** (≈ the 5% rake minus a small subsidy giveback), **never lost an event**, bankroll never negative. The ~17.7% from a tiny 6-user dry-run was a thin-pool/zero-bankroll artifact, not steady-state.
- **Demo data cleared from the real DB** (launch prep): `clearDemoMarkets()` + a purge of demo wallet rows → **0 `set_markets`, 0 `set_bets`, house bankroll $0**, wallet ledger = the 7 real $1000 grants only, every balance reconciles.

### 3. Payments research (advisory only — nothing implemented)
- Full report: **`docs/payments-research.md`** — Part 1 (USD vs Bitcoin), Part 2 (token models + Canada entry + geographic sequencing + 30/90/180 roadmap), Part 3 (fee structure: percentage vs flat).
- Agent memory: **`.claude/agent-memory/payment-rails-researcher/`** (operator profile, recommended structure, fee structure, Canada landmarks, wallet architecture).
- **Headlines:** operator is a solo **Canada-based** dev (Ontario-first). Start with **non-redeemable "social" tokens** (no cash-out → outside gambling + FINTRAC law); real money later only via a **licensed Ontario/Alberta supplier-or-partner**. **Avoid** sweepstakes/dual-currency (collapsing — 8+ US bans in 2026) and Kahnawake. **Fees: percentage rake (~5%) + per-bet minimum, NOT a flat fee**; put flat fees on deposits/withdrawals, separate ledger line. Crypto optional/last.

## DB schema added this session (all via `scripts/migrate-live-betting.js`, applied to the real DB)
- `users.balance_cents`; `wallet_transactions(user_id, amount_cents, type, ref_type, ref_id, created_at)`.
- `set_markets(... round_text, round_int, phase_group_id, player1_id, player2_id, p1_seed, p2_seed, state, p1_prob, p2_prob, seed_k_cents, p1_pool_cents, p2_pool_cents, p1_live_odds, p2_live_odds, winner_id, p1_score, p2_score, opened/closed/settled_at)`.
- `set_bets(user_id, market_id, picked_player_id, amount_cents, locked_odds, state, payout_cents, created_at)`.
- `tournaments.is_live`; `players_games_tournaments.seed_num` (futures). A reserved player named **"The Field"** backs the Field bet.

## Current data state
- Real DB: Evo 2026 has **real seed-based futures** (live-validated); **Evo France 2026** added (id 204, manual row). The 7 users are funded $1000 each.
- **Live-betting tables are clean** (2026-06-15): 0 `set_markets`, 0 `set_bets`, house bankroll **$0**, wallet ledger = the 7 grants only — all demo data was cleared for a clean launch baseline. Migrations are idempotent.
- Wipe helpers: `scripts/clear-futures.js` (futures); `liveMarkets.clearDemoMarkets()` (demo live-betting data).

## Open items / next steps
- **PR #1 is open** (`past-results-startgg-backfill` → `main`) and current; settle the open items below before merging. Nothing is uncommitted.
- **SQLite is a single-writer SPOF** — fine for play money; migrate to Postgres before any real money.
- **Payments = research only.** If pursuing: non-redeemable token model first (add a token unit, *no* withdrawal path), then a licensed Canadian route. Retain Canadian gaming/fintech counsel before real money.
- **Live poller** now targets each event's finals phase and was validated against a *completed* major (Evo 2025, all 16 events). Still unverified against a genuinely **in-progress** event — i.e. the live state-1→2→3 (open→close→settle) transitions over time. Watch one real live event to confirm the lifecycle, scores, and Grand Final Reset handling. (See §2b.)
- **Demo tools** are gated behind `ENABLE_DEMO=1` (dev-only); demo *data* has now been cleared from the real DB. Keep gated / remove the seed/close/settle/reset endpoints before a real-money launch.
- **Evo Vegas live test (June 26)** is the one remaining live-poller validation — it's operational, not schedulable: have the server running during the event (June 26 is in the auto-sync date window), confirm Evo 2026 `is_live`, and watch `/live`. A `/schedule` cloud routine can't do it (no access to the local DB/token). The replay harness has de-risked everything except real-time state timing.
- **Subagent Write is disabled** in this harness (the `payment-rails-researcher` agent can't write files even though its config lists Write) — the parent persists its output instead.

## Home page (✅ rebuilt 2026-06-15 — see §2c)
All six upgrades below were implemented and verified in a live preview:
1. **"🔴 Live Now" hero (highest impact).** Fetch `/api/live/markets`; if any market is `open`/`closed`, show a top hero with the live set(s) + a big CTA to `/live`. The marquee feature is currently invisible on the landing page. When nothing's live, show "Next live event" with a countdown.
2. **Wallet balance + quick stats.** Pull `/api/wallet?userId=` and show the balance prominently (it's only in the navbar now), plus simple P/L. The wallet is a core new primitive the home ignores.
3. **Unify "Your Bets."** It only shows futures bets today. Also fetch live bets (`/api/live/bets?userId=`) and merge them (WON/LOST/PENDING + payouts) so home is the single place to see all action.
4. **Countdowns on "Next Up."** Reuse the segmented `Countdown` component (now in `FutureTournaments.js`) so spotlight cards feel live, and label "Futures open in Xd" vs "Bet now" using the same 21-day gate.
5. **Logged-out hero + CTA.** The page looks identical logged-out — add a short value-prop hero and a Sign up / Login CTA, since home is the funnel.
6. **Polish:** the inline `TournamentLogo`/`GameLogo` components in `Home.js` are defined inside the component (same remount glitch we fixed elsewhere) — hoist them to module scope.

## Key files
- New: `wallet.js`, `liveOdds.js`, `liveMarkets.js`, `scripts/sync-live.js`, `scripts/replay-live.js`, `scripts/migrate-live-betting.js`, `scripts/recompute-futures.js`, `scripts/clear-futures.js`, `client/src/components/LiveBetting.{js,css}`, `client/src/components/Bracket.{js,css}`, `client/src/components/Countdown.{js,css}`, `docs/payments-research.md`, `docs/SESSION-HANDOFF.md`, `.claude/agents/payment-rails-researcher.md`, `.claude/agent-memory/payment-rails-researcher/*`.
- Modified: `server.js`, `scripts/sync-upcoming.js`, `client/src/App.js`, `client/src/components/{Navbar,FutureTournaments,PastResults}.{js,css}`, `client/src/index.css`.
