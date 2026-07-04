# Bracket Tracker — read-only pre-Top-8 round history

**Date:** 2026-07-04
**Status:** Draft — pending review
**Branch:** TBD (off `testing`)

## Problem

Before a tournament reaches Top 8, the Waiting Room shows a static "Projected
Top 8 from Start.gg seeding" skeleton — a Day-1 seed guess that never updates
as pools and early rounds actually complete. There's no way to follow a game's
progress (who's won, who's been eliminated) until the real Top 8 bracket
appears, even though start.gg already has that data throughout the event.

We explored (and shelved, for now) letting people stake FM on individual
Round of 64/32/16 matches — see the "Any possibility on betting on matches..."
discussion. That's a real follow-on, not this spec: it needs the same
round-tracking data this feature builds, plus separate work on market
volume/liquidity for many small early-round pools. This spec is the read-only
foundation; per-match staking on early rounds is an explicit non-goal here.

A working (uncommitted) prototype already validated the UI/UX in the real app
with real game logos — see `client/src/components/GameTracker.js` and the
per-game accordion in `WaitingRoom.js`. This spec covers making it real:
replacing the prototype's hardcoded sample rounds/results with actual
start.gg data.

## Goals

- Show real round-by-round progress per game, per tournament, before Top 8:
  which rounds are done, which is live, who won each tracked match so far.
- Show a "still alive" list of players who haven't been eliminated yet.
- Keep this reachable **after** Top 8 starts too — the round pills double as
  navigation between the live Bracket and this History view, so reaching
  Top 8 doesn't bury how someone got there (e.g. their Round of 16 result).
- No new FM markets, stakes, or odds anywhere in this feature.

## Non-goals (YAGNI)

- **No staking/picks on R64/R32/R16/QF matches.** Explicitly deferred — see
  Problem above. This feature only reads and displays start.gg's data.
- **No changes to Top 8 real-money markets, odds, or settlement.** The
  existing `set_markets` / `liveMarkets.js` flow is untouched.
- **No generic multi-tournament-format support beyond what start.gg reports.**
  We display whatever rounds start.gg's API gives us for that specific event,
  in order — we don't try to normalize wildly different bracket shapes (pools
  vs. straight double-elim vs. round-robin) into one universal template.

## Decisions (from brainstorming)

1. **Per-game accordion, not tabs.** One row per game, real logo only (no
   name text — logo + `title`/`aria-label` for accessibility), single-expand:
   tapping a game expands it in place while other games stay visible as
   collapsed rows. Tapping a different game collapses the current one.
   *(Built and verified in the prototype.)*
2. **Round pills are the navigation**, not a separate "Bracket / History"
   toggle. Each expanded game shows a strip of round pills; tapping "Top 8"
   shows the live interactive Bracket (unchanged, real markets); tapping any
   earlier round shows that round's results + who's still alive. Pills carry
   a status color (done/live/next) *and* a distinct "selected" ring for
   whichever one is currently being viewed — both are visible at once.
   *(Built and verified in the prototype.)*
3. **Round labels come from start.gg, not a fixed template.** The prototype's
   `R64 / R32 / R16 / QF / Top 8` labels were illustrative placeholders sized
   for a 32-entrant bracket. Real tournaments vary a lot (pools into Top 32,
   straight double-elim from Round 1, different entrant counts) — the real
   version lists whatever rounds start.gg actually reports for that event,
   ordered by `round_int` (the signed depth+side convention `liveMarkets.js`
   already uses: positive = winners side, negative = losers side, magnitude =
   distance from the final). **Open question for planning:** whether to
   collapse pools-phase sets into a single "Pools" pill instead of listing
   every pool round individually (large events could have many).
4. **"Still alive" reuses the existing seed endpoint**, minus anyone found as
   a loser in the new round-history data — so it's real data, not a fixed
   snapshot, and updates as results come in.
5. **Money-market lifecycle stays untouched.** Pre-Top-8 rounds are tracked
   in a brand-new, separate, read-only table — never `set_markets`. This
   guarantees the new tracking work cannot accidentally open/close/settle a
   real market or touch odds/bets.

## Architecture

### Poller: track earlier phases, not just the final one

`scripts/sync-live.js`'s `fetchActiveEvents()` currently resolves only each
event's **final** phase (`phases.reduce(...highest phaseOrder...)`) — that's
deliberate and stays exactly as-is for Top 8 / real markets.

New: a second, read-only pass fetches sets from the event's **other**
(non-final) phases — the phase enumeration already comes back from the
existing `LIVE_PHASES` query, so this is "fetch sets for the phases we
already know about but currently discard," not new phase-discovery work.

```
sync-live.js (existing, untouched)
  finalPhase sets  → processTournamentEvents() → set_markets (real FM markets)

sync-bracket-history.js (new)
  earlier-phase sets → processHistorySets() → bracket_history (read-only)
```

Whether this is a new sibling script (`scripts/sync-bracket-history.js`) or a
second function inside `sync-live.js` sharing the same poll tick is a planning
decision — either way it must never write to `set_markets`.

### New table: `bracket_history`

```sql
CREATE TABLE IF NOT EXISTS bracket_history (
  id INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL,
  game_id INTEGER NOT NULL,
  startgg_set_id TEXT NOT NULL UNIQUE,
  round_text TEXT,              -- start.gg's fullRoundText, e.g. "Winners Round 3"
  round_int INTEGER,             -- signed depth+side, same convention as set_markets
  phase_order INTEGER,
  state TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'in_progress' | 'completed'
  player1_id INTEGER, player2_id INTEGER, -- players.id
  winner_id INTEGER,                       -- players.id, once completed
  player1_score INTEGER, player2_score INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

Read-only from the app's perspective (only the poller writes to it) — a
pure history/status log, deliberately shaped nothing like `set_markets` so
there's no risk of it being mistaken for a bettable market anywhere.

### New API

`GET /api/game/:tournamentId/:gameId/tracker`

```json
{
  "rounds": [
    { "roundText": "Winners Round 1", "roundInt": 1, "status": "done" },
    { "roundText": "Winners Round 2", "roundInt": 2, "status": "live" },
    { "roundText": "Top 8", "roundInt": null, "status": "next" }
  ],
  "results": [
    { "winner": "GranTODAKAI", "loser": "Alioune", "score": "3-1", "round": "Winners Round 2", "completedAt": "..." }
  ],
  "stillAlive": [ { "seed": 1, "name": "GranTODAKAI" } ]
}
```

- `rounds`: distinct `round_text`/`round_int` pairs seen in `bracket_history`
  for this game, ordered by `round_int`, each with a `status` derived from its
  sets' `state` (all completed → done; any in_progress or a completed/pending
  mix → live; no rows yet → doesn't appear, the frontend appends "Top 8" as
  the final pill always).
- `results`: completed rows from `bracket_history`, newest first.
- `stillAlive`: the existing seed list (`/api/game/:id/:id/players`) with
  anyone appearing as a `loser` in `bracket_history` removed. Reuses existing
  data — no new seed-tracking logic.

### Frontend

`client/src/components/GameTracker.js` and the accordion in `WaitingRoom.js`
already exist as a working prototype. Real-data changes needed:

- Replace `SAMPLE_ROUNDS` / hardcoded `SAMPLE_RESULTS` with data fetched from
  the new `/tracker` endpoint per expanded game.
- Round pill list becomes dynamic (map over `rounds` from the API) instead of
  a fixed 5-item array — including always appending a final "Top 8" pill.
- Drop the "Sample data" disclaimer note once wired to real data.
- Everything else (accordion, single-expand, logo-only rows, round-pill
  selection/status styling, Bracket/History switch) carries over unchanged.

## Edge cases & failure handling

- **Tournament with no earlier-phase data yet** (pools not finished, or
  start.gg hasn't published brackets): `rounds` comes back empty except the
  ever-present "Top 8" pill — frontend shows today's "Projected Top 8 from
  seeding" note, unchanged from current behavior.
- **`/tracker` fetch fails:** fall back to showing just the "Top 8" pill and
  the existing projected-bracket view — never break the accordion.
- **A player's name doesn't match cleanly between `bracket_history` and the
  seed list** (e.g. a late change/DQ replacement): `stillAlive` may be
  briefly inconsistent; acceptable since this is read-only/informational, not
  something users act on financially.

## Testing

- **Backend (`node:test`):** the new poller pass writes `bracket_history` rows
  correctly from mocked start.gg phase data, without ever touching
  `set_markets`; `/tracker` derives round status and filters `stillAlive`
  correctly against sample fixtures.
- **Frontend (preview):** round pills render dynamically per event; status
  colors match backend data; selecting a round filters results; "Top 8" pill
  still shows the live real Bracket unchanged.

## Files touched (anticipated)

- `db/db.js` (new `bracket_history` table, boot-time `CREATE TABLE IF NOT EXISTS`)
- `scripts/sync-live.js` or a new `scripts/sync-bracket-history.js` (earlier-phase fetch + write)
- `server.js` (new `/api/game/:tournamentId/:gameId/tracker` route)
- `client/src/components/GameTracker.js` (real data instead of samples)
- `client/src/components/WaitingRoom.js` (dynamic round-pill list, fetch wiring)
- `test/` (poller + endpoint tests)
