# Manual results ingestion (non-start.gg majors)

## Why this exists

The app's entire tournament pipeline ingests from **start.gg only** — the daily
sync (`scheduleStartGgSync` in server.js) discovers majors via brand-name
searches and the live poller writes per-set markets for tournaments it already
knows. Some majors never touch start.gg: the **Esports World Cup main stage**
runs on EWC's own tournament platform (only its community LCQs use start.gg).
Those events are invisible to every sync, no matter what the whitelist says.

`scripts/ingest-manual-results.js` is the supported side door. It writes the
same rows the pipeline would have produced, so a hand-entered event renders
exactly like a synced one:

| Row | Purpose |
| --- | --- |
| `tournaments` (startgg_id NULL, is_live 0, winner_id set) | the event itself |
| `tournament_games` | game pill + entrant count on cards |
| `set_markets` (state `settled`, `manual-*` set ids, zeroed pools) | bracket sets → "Past Tournaments" on /tournaments |
| `matches` (Grand Final, negative synthetic startgg_id) | Home "Recent Champions" card |
| `bracket_history` (optional, `groupStages[]`) | pre-Top-8 round pills (Group Stage 1/2, etc.) — display only |

It deliberately does **not** write `players_games_tournaments` — that table
drives futures odds, and a finished manual event must never look bettable.
`bracket_history` never carries money either (no odds/pools columns at all) —
same as the live poller's own pre-Top-8 tracking for every synced tournament.

## Usage

```
node scripts/ingest-manual-results.js data/manual-results/<event>.json --dry-run
node scripts/ingest-manual-results.js data/manual-results/<event>.json
```

Re-running is safe: sets are keyed by `manual-<manualId>-<n>`, the Grand Final
match by a deterministic hash of `manualId`, and the tournament by exact name.

## Data file format

See [data/manual-results/ewc-2026-ffcotw.json](../data/manual-results/ewc-2026-ffcotw.json)
for a complete example (EWC 2026 Fatal Fury main stage, ingested 2026-07-11).

```jsonc
{
  "manualId": "ewc-2026-ffcotw",        // lowercase kebab-case, permanent key
  "tournament": {
    "name": "…",                         // exact display name (also the upsert key)
    "date": "2026-07-11T06:00:00.000Z",  // must be within the year filters used by the UI
    "city": "Paris", "country": "FR",
    "logoUrl": null                      // optional
  },
  "game": "Fatal Fury: City of the Wolves", // EXACT games.name
  "numEntrants": 8,                      // or null
  "sets": [                              // one entry per set, any bracket shape
    { "n": 1, "round": "Quarter-Final", "roundInt": 1,
      "p1": "REJECT | Laggia", "p2": "T1 | ZJZ",
      "p1Score": 5, "p2Score": 2, "at": "2026-07-11 09:00:00" }
  ],
  "groupStages": [                       // optional - pre-Top-8 progress, display only
    { "n": 1, "round": "Group Stage 1", "phaseOrder": 0,
      "p1": "REJECT | Laggia", "p2": "abao",
      "p1Score": 3, "p2Score": 1, "winner": 1 }
  ]
}
```

Rules the script enforces:

- **Player names must match `players.name` exactly** and are never
  auto-created — a typo fails loudly with near-match suggestions. This is what
  prevents silent duplicate players (see the `Evo France 2026` /
  `EVO FRANCE 2026` duplicate the case-sensitive sync dedup let through).
- Exactly one set with `round: "Grand Final"` (its winner becomes
  `tournaments.winner_id` and the Recent Champions card).
- Every set needs a decisive score.
- `roundInt` follows the sync's convention: positive winners-side rounds
  counting up to the Grand Final (LCQ example: Winners Semi 1, Winners Final 2,
  Grand Final 3; losers side negative). For single-elim: QF 1, SF 2, GF 3.
- `groupStages[]` entries need `winner` (1 or 2) instead of a decisive score -
  `p1Score`/`p2Score` may be `null` (bracket_history's score columns are
  nullable; a missing score doesn't block writing the round pill, unlike
  `sets[]` above). Re-running is safe here too: keyed by
  `manual-<manualId>-gs-<n>`.

## Behavior after ingestion

- An event dated **today** appears under "Happening Now" / current brackets;
  it moves to **Past Tournaments** once its date is strictly past (midnight
  UTC) — same lifecycle as a synced tournament (`liveMarkets.js` pastOnly
  filter: `date(t.date) < date('now')`).
- Home "Recent Champions" picks it up immediately via `/api/past-results`.

## Applying to production

The production DB lives on the Render service's disk. After the script + data
file are deployed (they ship with the repo):

```
ssh -o UpdateHostKeys=no srv-d8vi7ke8bjmc738arfd0@ssh.ohio.render.com \
  "cd /opt/render/project/src && /opt/render/project/nodes/node-20.20.2/bin/node \
   scripts/ingest-manual-results.js data/manual-results/<event>.json"
```

Use the **node-20 binary path** shown above: the SSH shell's default `node` is
v24 and cannot load the app's compiled better-sqlite3 (ABI mismatch).
`DATABASE_PATH` is already `/var/data/database.db` in the service env.

## Liquipedia: drafting the JSON automatically

`scripts/fetch-liquipedia-bracket.js` fetches an EWC (or any Liquipedia-
tracked) main-stage Finals Bracket and drafts most of a `data/manual-results/`
file for you — no more hand-transcribing every set from a broadcast VOD.

```
node scripts/fetch-liquipedia-bracket.js <LiquipediaPagePath> <manualId> [--out <path>]

# e.g. once the Grand Final has actually concluded:
node scripts/fetch-liquipedia-bracket.js Esports_World_Cup/2026/SF6 ewc-2026-sf6
```

`<LiquipediaPagePath>` is the page path under `liquipedia.net/fighters/`
(no leading slash) — e.g. `Esports_World_Cup/2026/SF6`, `Esports_World_Cup/2026/T8`.
Find it by searching liquipedia.net/fighters for the event.

It only extracts bracket **structure** — round labels, pairings, scores,
winners — never tournament metadata or this app's exact player-name
convention. Both still need filling in by hand afterward (the script marks
every such field `FILL ME IN`): tournament name/date/city/country, game
name, and each player's real `players.name` (Liquipedia only gives bare
gamertags — cross-reference the DB; `ingest-manual-results.js` will fail
loudly with near-match suggestions on a typo, same as ever).

Also pulls Group Stage 1 and Group Stage 2 (EWC's pre-Top-8 phases — 4
groups then 2, each an 8-player GSL-style double-elimination) into the
`groupStages[]` field, one flat round per phase rather than reproducing
every individual GSL sub-round — mirrors exactly how the live poller
already collapses every synced tournament's own pool stage into a single
"Pools" round (`scripts/sync-live.js`'s `isPoolsPhase`/`groupSetsIntoRounds`).
A group match with a known winner but no recoverable score (confirmed
happening on Liquipedia's own page for 2 of 60 Fatal Fury group matches —
an upstream data gap, not a parsing bug) is still included; only the Finals
Bracket's `sets[]` require a full score.

Refuses to write anything until every Finals Bracket match (except a
3rd-place decider) AND every group-stage match has a decided result, so
running it mid-event just prints progress instead of producing a partial
file someone could accidentally ingest — safe to re-run periodically as an
event progresses.

Currently only handles the standard EWC shape: Finals Bracket = 4
quarterfinals → 2 semifinals → 1 Grand Final; group stages = exactly 4
First-Phase groups + 2 Second-Phase groups, each exactly 10 matches. Fails
loudly rather than guess at a differently-shaped bracket or event format.

## Future: automated second source

If the remaining hand-fill step (metadata + player names) becomes a chore
too, an **admin endpoint/UI** wrapping the full pipeline (gated behind
`ADMIN_SECRET` like the existing `/api/admin/exhibition*` routes) is the
next practical step — the JSON format above stays the contract either way;
only the producer changes.
