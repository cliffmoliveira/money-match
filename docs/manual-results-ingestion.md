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

It deliberately does **not** write `players_games_tournaments` — that table
drives futures odds, and a finished manual event must never look bettable.

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

## Future: automated second source

If manual entry becomes a chore, the candidates are, in order of practicality:

1. **Liquipedia** (MediaWiki API, has EWC brackets) — parse the bracket page
   into this same JSON format, keep the ingest script as the single write path.
2. An **admin endpoint/UI** wrapping this script's logic (gate behind
   `ADMIN_SECRET` like the existing `/api/admin/exhibition*` routes).

Either way the JSON format above stays the contract; only the producer changes.
