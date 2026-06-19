# Live Waiting Room — preloaded Top 8 bracket + countdown

**Date:** 2026-06-19
**Status:** Approved design
**Branch:** `live-waiting-room` (off `affiliate-mock-sportsbook`)

## Problem

The Live page is dull while waiting for a tournament's Top 8. When there are no
open markets it shows a single line of text:

> "No live markets right now. Markets open automatically when a tracked tournament reaches Top 8."

We want the waiting state to feel alive: show the Top 8 bracket structure ahead
of time, a countdown, and visibly highlight the slots we're waiting to fill.

## Goals

- Replace the plain empty state with a **Waiting Room**: countdown + game
  selector + an empty Top 8 bracket skeleton.
- **Highlight the unfilled slots** so it's clear what we're waiting on.
- Seamlessly flip to the existing live view the moment markets open.
- Reuse what already exists (`Bracket`, `Countdown`) and add minimal backend.

## Non-goals (YAGNI)

- No **seed projections** / pre-filled matchups. Slots stay empty until Start.gg
  reports the set (upsets make projections wrong, and the user chose the honest
  "empty skeleton, fills live" option).
- No **per-game or precise Top 8 start time**. The countdown reuses the existing
  tournament `date` (UTC midnight of the start day).
- No new DB tables or columns.
- No change to live betting, odds, settlement, or the live rendering path.

## Decisions (from brainstorming)

1. **Bracket content:** empty skeleton; every slot is a highlighted "waiting"
   placeholder that fills in live as sets are reported.
2. **Countdown target:** the existing tournament `date`. Once it passes (event
   started, Top 8 not yet live), the timer area shows a "Top 8 hasn't started
   yet — standing by" status instead of a clock.
3. **Multiple games:** show **one game at a time** with a pill-tab game selector
   (default = first tracked game). A tournament may track many games (Evo tracks
   12), each with its own Top 8.
4. **Which tournament:** the soonest unfinished/active tracked tournament,
   reusing the live poller's existing "active tournament" definition
   (`is_live = 1` OR `date` within the poller's window).

## Architecture

`LiveBetting.js` becomes a thin router around the data it already polls:

```
LiveBetting (polls /api/live/markets every 15s)
  ├─ markets.length > 0          → existing live view (unchanged)
  └─ markets.length === 0
       ├─ fetch /api/live/upcoming
       ├─ tournament present      → <WaitingRoom tournament games />
       └─ tournament null/error   → simple "nothing scheduled" empty text
```

When polling detects markets, the parent unmounts `WaitingRoom` and renders the
live view — no reload.

### Components

- **`WaitingRoom.js`** (new, focused — one job: the pre-Top-8 view)
  - **Header:** tournament name + logo, `<Countdown date={tournament.date} />`,
    and a status line ("Markets open automatically when Top 8 begins" →
    "Top 8 hasn't started yet — standing by" after the date passes).
  - **Game selector:** pill tabs from `games` (reuse `.filter-tab` styling),
    default to the first; selecting a game re-renders the skeleton for it.
  - **Body:** the empty `<Bracket>` skeleton for the selected game.
  - Stateless re: data — receives `tournament` + `games` as props from the
    parent; owns only the selected-game UI state.

- **`Bracket.js`** (existing — light touch)
  - Already renders the fixed double-elim Top 8 template (Winners Semis ×2,
    Winners Final, Grand Final; Losers R1 ×2, R2 ×2, Losers Semis, Losers Final)
    with TBD placeholders + a "WAITING" badge when a slot has no market.
  - Change: render a clean full skeleton when given an empty market list, and
    apply the new "waiting" highlight class to empty slots. No change to how it
    renders real markets.

- **`Countdown.js`** (existing — reused unchanged)
  - Counts to `date`; shows "Happening now" / past-zero handled by WaitingRoom's
    status line.

### Data — one read-only endpoint

`GET /api/live/upcoming`

```json
{
  "tournament": { "id": 1, "name": "Evo 2026", "date": "2026-06-26", "logo": "evo" },
  "games": [ { "id": 10, "name": "Street Fighter 6" }, { "id": 11, "name": "TEKKEN 8" } ]
}
```

- Returns the soonest unfinished/active tracked tournament using the same
  "active tournament" logic the live poller already uses, or
  `{ "tournament": null }` when nothing is upcoming.
- `games` = the tournament's tracked games (join through the existing
  players/games/tournaments data the Futures page already uses).
- Read-only; no writes; no new tables. Lives alongside the other `/api/live/*`
  routes.

## Styling — "highlight the waiting spots"

- New `.bracket-node.waiting` (or equivalent) state: gold-tinted border + a slow,
  tasteful pulse adapted from the existing `mmPulse` keyframe, plus the existing
  "WAITING" badge. Goal: draw the eye to unfilled slots without being noisy.
- Countdown shown prominently at the top of the Waiting Room.
- Game tabs reuse the existing `.filter-tab` pill look.
- Mobile: the bracket is wide, so it scrolls horizontally within its container;
  tabs wrap. Consistent with the mobile bottom-nav work already shipped.

## Edge cases & failure handling

- **No upcoming tournament:** friendly "Nothing on the schedule right now" (a
  small upgrade over today's text).
- **Countdown past zero:** swap the clock for "Top 8 hasn't started yet —
  standing by"; keep polling.
- **`/api/live/upcoming` fails:** fall back to today's simple empty message —
  never break the Live page.
- **markets → live transition:** parent detects markets on the next poll and
  renders the live view; WaitingRoom unmounts cleanly.

## Testing

- **Backend (`node:test`, like the affiliate suite):** `/api/live/upcoming`
  returns the soonest upcoming tracked tournament + its games; excludes finished
  tournaments; returns `{ tournament: null }` when none exist.
- **Frontend (preview/tunnel):** countdown ticks; game tabs switch the skeleton;
  empty bracket renders with pulsing waiting slots; the view flips to the live
  bracket when markets are seeded via the existing `/api/live/seed-demo`.

## Files touched (anticipated)

- `client/src/components/WaitingRoom.js` (new) + `WaitingRoom.css` (new)
- `client/src/components/LiveBetting.js` (router branch for the empty state)
- `client/src/components/Bracket.js` + `Bracket.css` (empty skeleton + waiting highlight)
- `server.js` and/or `liveMarkets.js` (the `/api/live/upcoming` handler + query)
- `test/` (endpoint test)
