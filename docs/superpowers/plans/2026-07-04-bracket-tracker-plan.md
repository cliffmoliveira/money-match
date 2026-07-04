# Bracket Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Waiting Room's static "Projected Top 8 from seeding" skeleton with real round-by-round history per game — which rounds are done/live, who won each tracked match, and who's still alive — reachable both before and after Top 8 starts via the round-pill nav already built in the working prototype.

**Architecture:** The poller (`scripts/sync-live.js`) already resolves each event's phases but only fetches sets from the *final* phase (Top 8, real money markets — untouched by this plan). This plan adds a second, read-only pass that fetches sets from every *other* phase and writes them into a brand-new `bracket_history` table — deliberately separate from `set_markets` so it can never touch odds, stakes, or settlement. A new query function + endpoint serve that data; the existing prototype UI (`WaitingRoom.js` accordion, `GameTracker.js`) swaps its hardcoded sample rounds/results for the real thing.

**Tech Stack:** Express + better-sqlite3 (`db/db.js` async helpers), start.gg GraphQL (`startggClient.js`), React (CRA), `node:test` for backend tests.

---

## File Structure

- **`db/db.js`** (modify) — boot-time `CREATE TABLE IF NOT EXISTS bracket_history`, alongside the existing `follows` table setup.
- **`scripts/sync-live.js`** (modify) — `LIVE_PHASES` query gains `name` per phase; new `isPoolsPhase()`, `classifyRoundStatus()`, `groupSetsIntoRounds()`, `fetchHistoryPhases()`, `processHistorySets()`; wired into `syncLive()` as an additional per-tournament pass.
- **`test/live/bracket-history.test.js`** (create) — `node:test` for the new pure functions + DB writes.
- **`liveMarkets.js`** (modify) — add `getGameTracker(tournamentId, gameId)` query function + export.
- **`test/live/tracker.test.js`** (create) — `node:test` for `getGameTracker()`.
- **`server.js`** (modify) — add `GET /api/game/:tournamentId/:gameId/tracker` route.
- **`client/src/components/GameTracker.js`** (modify) — drop `SAMPLE_ROUNDS`/`SAMPLE_RESULTS`, accept `results` + `seeds` as props (rounds now owned by `WaitingRoom.js`, see below).
- **`client/src/components/GameTracker.css`** (no change expected).
- **`client/src/components/WaitingRoom.js`** (modify) — fetch `/tracker` per expanded game; round-pill list built from the fetched `rounds` (+ an always-appended "Top 8" pill) instead of the static `SAMPLE_ROUNDS` import.

**Note on TDD:** Backend tasks (T0–T4) are full TDD. Frontend tasks (T5–T6) are implement-then-verify in the running preview, matching how the existing prototype was already verified — there's no React test harness in this app.

---

### Task 0: `bracket_history` table

**Files:**
- Modify: `db/db.js` (add near the existing `follows` table setup, ~line 48)

- [ ] **Step 1: Add the boot-time table**

Insert right after the existing `follows` table block in `db/db.js`:

```js
// Bracket tracker: read-only round-by-round history for pre-Top-8 rounds
// (Pools, Winners/Losers Round N, ...). Deliberately separate from
// set_markets — this table is never read by the odds engine, never opens/
// closes/settles a market, and carries no money. Written only by the poller
// (scripts/sync-live.js); the API only ever reads it.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bracket_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      game_id INTEGER NOT NULL,
      startgg_set_id TEXT NOT NULL UNIQUE,
      round_text TEXT,
      round_int INTEGER,
      phase_order INTEGER,
      state TEXT NOT NULL DEFAULT 'pending',
      player1_id INTEGER,
      player2_id INTEGER,
      winner_id INTEGER,
      player1_score INTEGER,
      player2_score INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
} catch (e) { console.error('[boot] bracket_history table setup failed:', e.message); }
```

- [ ] **Step 2: Verify it boots cleanly**

Run: `node -e "require('./db/db')"` (with `DATABASE_PATH` pointed at a scratch file, e.g. `DATABASE_PATH=/tmp/bh-check.db node -e "require('./db/db')"`)
Expected: prints the usual boot diagnostics, no `[boot] bracket_history table setup failed` line.

- [ ] **Step 3: Commit**

```bash
git add db/db.js
git commit -m "feat(tracker): add bracket_history table"
```

---

### Task 1: `isPoolsPhase()` + phase `name` in the poller query (TDD)

**Files:**
- Modify: `scripts/sync-live.js` (`LIVE_PHASES` query ~line 25; add helper near `isTop8Round`, ~line 71)
- Test: `test/live/bracket-history.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/live/bracket-history.test.js`. Set up the shared temp-DB scaffolding
from the start (mirrors `test/live/upcoming.test.js`) even though this first
test doesn't touch the DB — later tests appended in Tasks 2–3 reuse the same
`db`/`syncLive` bindings instead of each rolling their own setup:

```js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let db, syncLive, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-bh-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  delete require.cache[require.resolve('../../scripts/sync-live')];
  db = require('../../db/db');
  syncLive = require('../../scripts/sync-live');
  await db.runAsync(`CREATE TABLE bracket_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER,
    startgg_set_id TEXT UNIQUE, round_text TEXT, round_int INTEGER, phase_order INTEGER,
    state TEXT, player1_id INTEGER, player2_id INTEGER, winner_id INTEGER,
    player1_score INTEGER, player2_score INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await db.runAsync(`CREATE TABLE set_markets (id INTEGER PRIMARY KEY, startgg_set_id TEXT, state TEXT)`);
  await db.runAsync(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT, country TEXT, startgg_id TEXT, photo_url TEXT)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM bracket_history');
  await db.runAsync('DELETE FROM set_markets');
  await db.runAsync('DELETE FROM players');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

test('isPoolsPhase matches common pools phase names, case-insensitively', () => {
  assert.equal(syncLive.isPoolsPhase('Pools'), true);
  assert.equal(syncLive.isPoolsPhase('Pool A'), true);
  assert.equal(syncLive.isPoolsPhase('pool b'), true);
  assert.equal(syncLive.isPoolsPhase('Winners Round 1'), false);
  assert.equal(syncLive.isPoolsPhase('Top 8'), false);
  assert.equal(syncLive.isPoolsPhase(undefined), false);
  assert.equal(syncLive.isPoolsPhase(''), false);
});
```

(The `bracket_history`/`set_markets`/`players` tables created here aren't used
until Task 3's test — declaring them now means Task 3 only adds its own test
case, not a second parallel DB setup.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/live/bracket-history.test.js`
Expected: FAIL — `isPoolsPhase is not a function` (not yet exported).

- [ ] **Step 3: Add `name` to the phases query and implement `isPoolsPhase()`**

In `scripts/sync-live.js`, change the `LIVE_PHASES` query's `phases` selection:

```js
const LIVE_PHASES = `
query LivePhases($id: ID!) {
  tournament(id: $id) {
    id name
    events {
      id name videogame { id name }
      phases { id name phaseOrder }
    }
  }
}`;
```

Add this helper right after `isTop8Round` (~line 71):

```js
// A "Pools" (or "Pool A"/"Pool B"/...) phase collapses into a single synthetic
// "Pools" round in the tracker instead of listing every individual pool round
// — large events can have dozens, and the useful granularity there is "are
// pools done yet," not which specific pool.
function isPoolsPhase(name) {
  return /pool/i.test(name || '');
}
```

- [ ] **Step 4: Export it**

In `scripts/sync-live.js`'s `module.exports`, add `isPoolsPhase`:

```js
module.exports = { syncLive, processTournamentEvents, fetchActiveEvents, selectTop8Sets, isTop8Round, isPoolsPhase };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/live/bracket-history.test.js`
Expected: PASS — 1 test.

- [ ] **Step 6: Commit**

```bash
git add scripts/sync-live.js test/live/bracket-history.test.js
git commit -m "feat(tracker): isPoolsPhase() + phase name in the live-phases query"
```

---

### Task 2: `classifyRoundStatus()` + `groupSetsIntoRounds()` (TDD)

**Files:**
- Modify: `scripts/sync-live.js` (add near `isPoolsPhase`)
- Test: `test/live/bracket-history.test.js` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/live/bracket-history.test.js` (reuses the `syncLive` binding
already set up in `before()` from Task 1 — no new `require`):

```js
test('classifyRoundStatus: done only when every set is state 3', () => {
  assert.equal(syncLive.classifyRoundStatus([{ state: 3 }, { state: 3 }]), 'done');
  assert.equal(syncLive.classifyRoundStatus([{ state: 3 }, { state: 2 }]), 'live');
  assert.equal(syncLive.classifyRoundStatus([{ state: 1 }, { state: 1 }]), 'live');
  assert.equal(syncLive.classifyRoundStatus([]), 'live');
});

test('groupSetsIntoRounds: collapses pools phases into one "Pools" group', () => {
  const phases = [
    { eventId: 1, phaseOrder: 1, phaseName: 'Pool A', sets: [{ id: 's1', state: 3, fullRoundText: 'Pool A Round 1', round: 1 }] },
    { eventId: 1, phaseOrder: 1, phaseName: 'Pool B', sets: [{ id: 's2', state: 2, fullRoundText: 'Pool B Round 1', round: 1 }] },
    { eventId: 1, phaseOrder: 2, phaseName: 'Bracket', sets: [{ id: 's3', state: 1, fullRoundText: 'Winners Round 1', round: 1 }] },
  ];
  const groups = syncLive.groupSetsIntoRounds(phases);
  const pools = groups.find((g) => g.roundText === 'Pools');
  assert.ok(pools, 'expected a single Pools group');
  assert.equal(pools.sets.length, 2);
  assert.equal(pools.roundInt, null);
  assert.equal(pools.phaseOrder, 1);

  const bracket = groups.find((g) => g.roundText === 'Winners Round 1');
  assert.ok(bracket);
  assert.equal(bracket.sets.length, 1);
  assert.equal(bracket.roundInt, 1);
});

test('groupSetsIntoRounds: bracket-phase sets group by round text, not individually per set', () => {
  const phases = [
    {
      eventId: 1, phaseOrder: 2, phaseName: 'Bracket',
      sets: [
        { id: 's1', state: 3, fullRoundText: 'Winners Round 1', round: 1 },
        { id: 's2', state: 3, fullRoundText: 'Winners Round 1', round: 1 },
        { id: 's3', state: 1, fullRoundText: 'Winners Round 2', round: 2 },
      ],
    },
  ];
  const groups = syncLive.groupSetsIntoRounds(phases);
  assert.equal(groups.length, 2);
  const r1 = groups.find((g) => g.roundText === 'Winners Round 1');
  assert.equal(r1.sets.length, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/live/bracket-history.test.js`
Expected: FAIL — `syncLive.classifyRoundStatus is not a function`.

- [ ] **Step 3: Implement both functions**

Add to `scripts/sync-live.js`, right after `isPoolsPhase`:

```js
// A round is "done" only once every set in it has reported a winner (state 3);
// otherwise it's "live" — covers both "in progress" and "not started yet but
// we already know the matchup," which read the same to a viewer (the round is
// underway). There's no "next" here: a round with zero known sets simply
// doesn't appear in the grouped output at all.
function classifyRoundStatus(sets = []) {
  return sets.length > 0 && sets.every((s) => s.state === 3) ? 'done' : 'live';
}

// Turns the per-phase set lists from fetchHistoryPhases() into the round
// buckets the tracker displays: every pools phase collapses into one
// synthetic "Pools" group (roundInt: null, phaseOrder = the lowest pools
// phaseOrder seen), while bracket-phase sets group by their own round text
// (start.gg reports the same fullRoundText/round for every set in a round).
function groupSetsIntoRounds(historyPhases = []) {
  const byRoundText = new Map();
  let poolsPhaseOrder = null;

  for (const phase of historyPhases) {
    if (isPoolsPhase(phase.phaseName)) {
      if (poolsPhaseOrder === null || phase.phaseOrder < poolsPhaseOrder) poolsPhaseOrder = phase.phaseOrder;
      const key = 'Pools';
      if (!byRoundText.has(key)) byRoundText.set(key, { roundText: 'Pools', roundInt: null, phaseOrder: phase.phaseOrder, sets: [] });
      byRoundText.get(key).sets.push(...phase.sets);
      continue;
    }
    for (const set of phase.sets) {
      const key = set.fullRoundText || `phase-${phase.phaseOrder}`;
      if (!byRoundText.has(key)) {
        byRoundText.set(key, { roundText: key, roundInt: set.round ?? null, phaseOrder: phase.phaseOrder, sets: [] });
      }
      byRoundText.get(key).sets.push(set);
    }
  }

  const groups = [...byRoundText.values()];
  const pools = groups.find((g) => g.roundText === 'Pools');
  if (pools && poolsPhaseOrder !== null) pools.phaseOrder = poolsPhaseOrder;
  return groups;
}
```

- [ ] **Step 4: Export both**

```js
module.exports = {
  syncLive, processTournamentEvents, fetchActiveEvents, selectTop8Sets, isTop8Round,
  isPoolsPhase, classifyRoundStatus, groupSetsIntoRounds,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/live/bracket-history.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/sync-live.js test/live/bracket-history.test.js
git commit -m "feat(tracker): classifyRoundStatus() + groupSetsIntoRounds()"
```

---

### Task 3: `fetchHistoryPhases()` + `processHistorySets()` (TDD)

**Files:**
- Modify: `scripts/sync-live.js` (add near `fetchActiveEvents`, ~line 253; add near `processTournamentEvents`, ~line 138)
- Test: `test/live/bracket-history.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/live/bracket-history.test.js` (reuses the `db`/`syncLive`
bindings and tables already set up in `before()` from Task 1 — no new
scaffolding):

```js
test('processHistorySets writes one bracket_history row per set, never touching set_markets', async () => {
  const roundGroup = {
    roundText: 'Winners Round 1', roundInt: 1, phaseOrder: 2,
    sets: [{
      id: 'hset1', state: 3, fullRoundText: 'Winners Round 1', round: 1,
      winnerId: 'e1',
      slots: [
        { entrant: { id: 'e1', name: 'GranTODAKAI', seeds: [{ seedNum: 1 }] }, standing: { stats: { score: { value: 3 } } } },
        { entrant: { id: 'e2', name: 'Alioune', seeds: [{ seedNum: 17 }] }, standing: { stats: { score: { value: 1 } } } },
      ],
    }],
  };

  await syncLive.processHistorySets({ id: 1 }, 10, [roundGroup]);

  const rows = await db.allAsync('SELECT * FROM bracket_history');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].startgg_set_id, 'hset1');
  assert.equal(rows[0].round_text, 'Winners Round 1');
  assert.equal(rows[0].state, 'completed');
  assert.equal(rows[0].player1_score, 3);
  assert.equal(rows[0].player2_score, 1);

  const marketRows = await db.allAsync('SELECT * FROM set_markets');
  assert.equal(marketRows.length, 0, 'processHistorySets must never write to set_markets');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/live/bracket-history.test.js`
Expected: FAIL — `syncLive.processHistorySets is not a function`.

- [ ] **Step 3: Implement `fetchHistoryPhases()` and `processHistorySets()`**

Add `fetchHistoryPhases` right after `fetchActiveEvents` in `scripts/sync-live.js` (~line 265):

```js
/**
 * Sets from every phase EXCEPT the final one (fetchActiveEvents already
 * covers the final/Top-8 phase for real markets). Read-only — feeds
 * bracket_history via processHistorySets, never set_markets. Returns one
 * entry per non-final phase so groupSetsIntoRounds can tell pools apart from
 * bracket rounds by phaseName.
 */
async function fetchHistoryPhases(startggId) {
  const data = await startgg(LIVE_PHASES, { id: startggId });
  const events = data?.tournament?.events || [];
  const out = [];
  for (const ev of events) {
    const phases = ev.phases || [];
    if (phases.length < 2) continue; // nothing before the final phase to track
    const finalPhase = phases.reduce((a, b) => ((b.phaseOrder ?? 0) > (a.phaseOrder ?? 0) ? b : a));
    for (const phase of phases) {
      if (phase.id === finalPhase.id) continue;
      const nodes = await fetchPhaseSets(ev.id, phase.id);
      out.push({ eventId: ev.id, videogame: ev.videogame, phaseOrder: phase.phaseOrder ?? 0, phaseName: phase.name, sets: nodes });
    }
  }
  return out;
}
```

Add `processHistorySets` right after `processTournamentEvents` in `scripts/sync-live.js` (~line 228):

```js
/**
 * Writes grouped round data (from groupSetsIntoRounds) into bracket_history —
 * one row per start.gg set, upserted by startgg_set_id. Read-only history:
 * never touches set_markets, odds, or bets. `tRow` is our tournaments row
 * ({ id, ... }); `gameId` is our games.id for this event's videogame.
 */
async function processHistorySets(tRow, gameId, roundGroups = []) {
  for (const group of roundGroups) {
    for (const set of group.sets) {
      const e0 = set.slots?.[0]?.entrant;
      const e1 = set.slots?.[1]?.entrant;
      const setId = String(set.id);
      const state = set.state === 3 ? 'completed' : set.state === 2 ? 'in_progress' : 'pending';

      let p0 = null, p1 = null, winnerPid = null;
      if (e0?.id) p0 = await findOrCreatePlayerId(e0);
      if (e1?.id) p1 = await findOrCreatePlayerId(e1);
      if (set.state === 3 && set.winnerId != null) {
        const winnerEntrant = set.winnerId === e0?.id ? e0 : e1;
        if (winnerEntrant) winnerPid = await findOrCreatePlayerId(winnerEntrant);
      }

      const existing = await db.getAsync('SELECT id FROM bracket_history WHERE startgg_set_id = ?', [setId]);
      const params = [
        tRow.id, gameId, setId, group.roundText, group.roundInt, group.phaseOrder,
        state, p0, p1, winnerPid, scoreOf(set.slots?.[0]), scoreOf(set.slots?.[1]),
      ];
      if (existing) {
        await db.runAsync(
          `UPDATE bracket_history SET
             round_text=?, round_int=?, phase_order=?, state=?,
             player1_id=?, player2_id=?, winner_id=?, player1_score=?, player2_score=?,
             updated_at=CURRENT_TIMESTAMP
           WHERE startgg_set_id=?`,
          [group.roundText, group.roundInt, group.phaseOrder, state, p0, p1, winnerPid,
            scoreOf(set.slots?.[0]), scoreOf(set.slots?.[1]), setId]
        );
      } else {
        await db.runAsync(
          `INSERT INTO bracket_history
             (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_order,
              state, player1_id, player2_id, winner_id, player1_score, player2_score)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          params
        );
      }
    }
  }
}
```

- [ ] **Step 4: Export both**

```js
module.exports = {
  syncLive, processTournamentEvents, fetchActiveEvents, selectTop8Sets, isTop8Round,
  isPoolsPhase, classifyRoundStatus, groupSetsIntoRounds, fetchHistoryPhases, processHistorySets,
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/live/bracket-history.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/sync-live.js test/live/bracket-history.test.js
git commit -m "feat(tracker): fetchHistoryPhases() + processHistorySets()"
```

---

### Task 4: Wire the history pass into `syncLive()` + `getGameTracker()` query (TDD)

**Files:**
- Modify: `scripts/sync-live.js` (`syncLive()` loop, ~line 282)
- Modify: `liveMarkets.js` (add `getGameTracker`, export it)
- Test: `test/live/tracker.test.js` (create)

- [ ] **Step 1: Wire the history pass into `syncLive()`**

In `scripts/sync-live.js`, inside the `for (const tRow of tournaments)` loop in `syncLive()`, after the existing `processTournamentEvents` call:

```js
    try {
      const events = await fetchActiveEvents(tRow.startgg_id);
      const s = await processTournamentEvents(tRow, events);
      totals.tournaments++;
      totals.opened += s.opened; totals.closed += s.closed; totals.settled += s.settled;

      // Read-only round history for pre-Top-8 rounds — separate pass, separate
      // table, never touches set_markets/odds/bets.
      const historyPhases = await fetchHistoryPhases(tRow.startgg_id);
      const byGame = new Map();
      for (const phase of historyPhases) {
        const gameId = await findOrCreateGameId(phase.videogame);
        if (!gameId) continue;
        if (!byGame.has(gameId)) byGame.set(gameId, []);
        byGame.get(gameId).push(phase);
      }
      for (const [gameId, phases] of byGame) {
        await processHistorySets(tRow, gameId, groupSetsIntoRounds(phases));
      }
    } catch (err) {
      console.error(`[sync-live] ${tRow.name} (${tRow.startgg_id}) failed: ${err.message}`);
    }
```

(This replaces the existing `try { ... } catch` block in the loop — the new code goes inside the same `try`, after the existing `totals.settled += s.settled;` line.)

- [ ] **Step 2: Write the failing test for `getGameTracker()`**

Create `test/live/tracker.test.js`:

```js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

let db, lm, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-tracker-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  delete require.cache[require.resolve('../../liveMarkets')];
  db = require('../../db/db');
  lm = require('../../liveMarkets');
  await db.runAsync(`CREATE TABLE bracket_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tournament_id INTEGER, game_id INTEGER,
    startgg_set_id TEXT UNIQUE, round_text TEXT, round_int INTEGER, phase_order INTEGER,
    state TEXT, player1_id INTEGER, player2_id INTEGER, winner_id INTEGER,
    player1_score INTEGER, player2_score INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await db.runAsync(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT)`);
  await db.runAsync(`CREATE TABLE players_games_tournaments (tournament_id INTEGER, game_id INTEGER, player_id INTEGER, seed_num INTEGER)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM bracket_history');
  await db.runAsync('DELETE FROM players');
  await db.runAsync('DELETE FROM players_games_tournaments');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

async function addPlayer(id, name) { await db.runAsync('INSERT INTO players (id, name) VALUES (?,?)', [id, name]); }
async function addHistory(row) {
  await db.runAsync(
    `INSERT INTO bracket_history
       (tournament_id, game_id, startgg_set_id, round_text, round_int, phase_order, state, player1_id, player2_id, winner_id, player1_score, player2_score)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.tournamentId, row.gameId, row.setId, row.roundText, row.roundInt ?? null, row.phaseOrder ?? 0,
      row.state, row.p1, row.p2, row.winner ?? null, row.s1 ?? null, row.s2 ?? null]
  );
}
async function seedPlayer(tournamentId, gameId, playerId, seedNum) {
  await db.runAsync('INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, seed_num) VALUES (?,?,?,?)',
    [tournamentId, gameId, playerId, seedNum]);
}

test('getGameTracker groups rounds by status and lists results newest-first', async () => {
  await addPlayer(1, 'GranTODAKAI'); await addPlayer(2, 'Alioune');
  await addHistory({ tournamentId: 1, gameId: 10, setId: 's1', roundText: 'Winners Round 1', roundInt: 1, phaseOrder: 2, state: 'completed', p1: 1, p2: 2, winner: 1, s1: 3, s2: 1 });
  await addHistory({ tournamentId: 1, gameId: 10, setId: 's2', roundText: 'Winners Round 2', roundInt: 2, phaseOrder: 2, state: 'in_progress', p1: 1, p2: 2 });

  const result = await lm.getGameTracker(1, 10);
  assert.deepEqual(result.rounds.map((r) => r.roundText), ['Winners Round 1', 'Winners Round 2']);
  assert.equal(result.rounds.find((r) => r.roundText === 'Winners Round 1').status, 'done');
  assert.equal(result.rounds.find((r) => r.roundText === 'Winners Round 2').status, 'live');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].winner, 'GranTODAKAI');
  assert.equal(result.results[0].loser, 'Alioune');
  assert.equal(result.results[0].score, '3-1');
});

test('getGameTracker stillAlive excludes anyone who has lost a completed set', async () => {
  await addPlayer(1, 'GranTODAKAI'); await addPlayer(2, 'Alioune');
  await seedPlayer(1, 10, 1, 1);
  await seedPlayer(1, 10, 2, 17);
  await addHistory({ tournamentId: 1, gameId: 10, setId: 's1', roundText: 'Winners Round 1', roundInt: 1, phaseOrder: 2, state: 'completed', p1: 1, p2: 2, winner: 1, s1: 3, s2: 1 });

  const result = await lm.getGameTracker(1, 10);
  assert.deepEqual(result.stillAlive.map((p) => p.name), ['GranTODAKAI']);
});

test('getGameTracker returns empty arrays when nothing is tracked yet', async () => {
  const result = await lm.getGameTracker(999, 999);
  assert.deepEqual(result.rounds, []);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.stillAlive, []);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/live/tracker.test.js`
Expected: FAIL — `lm.getGameTracker is not a function`.

- [ ] **Step 4: Implement `getGameTracker()` in `liveMarkets.js`**

Add near the other exported query functions (e.g. just before `module.exports`):

```js
// Read-only: round-by-round history for a game's pre-Top-8 rounds — powers
// the Bracket Tracker's round pills, results feed, and still-alive list.
// Entirely separate from set_markets: no odds, no stakes, nothing bettable.
async function getGameTracker(tournamentId, gameId) {
  const rows = await db.allAsync(
    `SELECT round_text, round_int, phase_order, state,
            player1_id, player2_id, winner_id, player1_score, player2_score, updated_at
     FROM bracket_history
     WHERE tournament_id = ? AND game_id = ?
     ORDER BY phase_order ASC, round_int ASC, updated_at DESC`,
    [tournamentId, gameId]
  );

  const byRound = new Map();
  for (const r of rows) {
    const key = r.round_text;
    if (!byRound.has(key)) byRound.set(key, { roundText: r.round_text, roundInt: r.round_int, phaseOrder: r.phase_order, sets: [] });
    byRound.get(key).sets.push(r);
  }
  const rounds = [...byRound.values()].map((g) => ({
    roundText: g.roundText,
    roundInt: g.roundInt,
    status: g.sets.every((s) => s.state === 'completed') ? 'done' : 'live',
  }));

  const playerIds = [...new Set(rows.flatMap((r) => [r.player1_id, r.player2_id]).filter(Boolean))];
  const players = playerIds.length
    ? await db.allAsync(`SELECT id, name FROM players WHERE id IN (${playerIds.map(() => '?').join(',')})`, playerIds)
    : [];
  const nameOf = (id) => players.find((p) => p.id === id)?.name || null;

  const completed = rows.filter((r) => r.state === 'completed' && r.winner_id != null)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const results = completed.map((r) => {
    const winnerIsP1 = r.winner_id === r.player1_id;
    const loserId = winnerIsP1 ? r.player2_id : r.player1_id;
    const winnerScore = winnerIsP1 ? r.player1_score : r.player2_score;
    const loserScore = winnerIsP1 ? r.player2_score : r.player1_score;
    return {
      winner: nameOf(r.winner_id),
      loser: nameOf(loserId),
      score: `${winnerScore ?? 0}-${loserScore ?? 0}`,
      round: r.round_text,
    };
  });

  const losers = new Set(completed.map((r) => (r.winner_id === r.player1_id ? r.player2_id : r.player1_id)).filter(Boolean));
  const seeds = await db.allAsync(
    `SELECT pgt.player_id, p.name AS player_name, pgt.seed_num
     FROM players_games_tournaments pgt
     JOIN players p ON p.id = pgt.player_id
     WHERE pgt.tournament_id = ? AND pgt.game_id = ? AND pgt.seed_num IS NOT NULL
     ORDER BY pgt.seed_num`,
    [tournamentId, gameId]
  );
  const stillAlive = seeds
    .filter((s) => !losers.has(s.player_id))
    .map((s) => ({ seed: s.seed_num, name: s.player_name }));

  return { rounds, results, stillAlive };
}
```

- [ ] **Step 5: Export it**

Add `getGameTracker` to `liveMarkets.js`'s `module.exports`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/live/tracker.test.js`
Expected: PASS — 3 tests.
Also run: `node --test test/` to confirm nothing else regressed (expect the same pre-existing 4 unrelated failures in `test/live/upcoming.test.js`, now 5 new passing tests added on top).

- [ ] **Step 7: Commit**

```bash
git add scripts/sync-live.js liveMarkets.js test/live/tracker.test.js
git commit -m "feat(tracker): wire history pass into syncLive() + getGameTracker() query"
```

---

### Task 5: `GET /api/game/:tournamentId/:gameId/tracker` route

**Files:**
- Modify: `server.js` (after the existing `/api/game/:tournamentId/:gameId/players` route, ~line 525)

- [ ] **Step 1: Add the route**

```js
// Read-only: round-by-round bracket history for a game (Pools, Winners/Losers
// Round N, ...) — powers the Bracket Tracker. No auth, no writes, nothing
// bettable.
app.get('/api/game/:tournamentId/:gameId/tracker', async (req, res) => {
  const { tournamentId, gameId } = req.params;
  try {
    res.json(await liveMarkets.getGameTracker(tournamentId, gameId));
  } catch (err) {
    console.error('Error fetching bracket tracker:', err.message);
    res.status(500).json({ error: 'Failed to fetch bracket tracker' });
  }
});
```

- [ ] **Step 2: Smoke-test against the dev DB**

Run (with the backend running on :5000):
`curl -s http://localhost:5000/api/game/1/1/tracker`
Expected: JSON `{ "rounds": [...], "results": [...], "stillAlive": [...] }` (200), all empty arrays if nothing's tracked yet for that id pair. Must not 500.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(tracker): GET /api/game/:tournamentId/:gameId/tracker endpoint"
```

---

### Task 6: Frontend — wire the prototype to real data

**Files:**
- Modify: `client/src/components/GameTracker.js`
- Modify: `client/src/components/WaitingRoom.js`

- [ ] **Step 1: Simplify `GameTracker.js` to accept real data as props**

Replace the whole file:

```jsx
import React from 'react';
import './GameTracker.css';

// Round-by-round tracker body: the results feed (optionally scoped to one
// round) + who's still alive. The round-pill strip itself lives in
// WaitingRoom.js, since it doubles as the nav between this view and the live
// Bracket.
const GameTracker = ({ seeds = [], results = [], roundLabel }) => {
  const shown = roundLabel ? results.filter((r) => r.round === roundLabel) : results;

  return (
    <div className="gt-tracker">
      <div className="gt-section-title">{roundLabel ? `${roundLabel} results` : 'Recent results'}</div>
      <div className="gt-results">
        {shown.length === 0 && <p className="gt-empty">No results tracked for this round yet.</p>}
        {shown.map((r, i) => (
          <div className="gt-result-row" key={`${r.winner}-${r.loser}-${i}`}>
            <div className="gt-result-top">
              <span className="gt-result-winner">{r.winner}</span>
            </div>
            <div className="gt-result-bottom">
              <span className="gt-result-meta">def. {r.loser} &middot; {r.score}</span>
              <span className="gt-result-round">{r.round}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="gt-section-title">Still alive</div>
      <div className="gt-alive">
        {seeds.length === 0 && <p className="gt-empty">Seeding not available yet.</p>}
        {seeds.map((p) => (
          <div className="gt-alive-row" key={p.seed}>
            <span className="gt-alive-seed">{p.seed}</span>
            <span className="gt-alive-name">{p.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default GameTracker;
```

(Drops the "Sample data" disclaimer and the `isNew`/badge styling along with the
now-removed hardcoded `SAMPLE_ROUNDS`/`SAMPLE_RESULTS` — this is real data now.
`gt-new`/`gt-result-badge` CSS in `GameTracker.css` can stay unused or be
trimmed; harmless either way.)

- [ ] **Step 2: Fetch the tracker per expanded game in `WaitingRoom.js`**

Remove the `SAMPLE_ROUNDS` import:

```diff
-import GameTracker, { SAMPLE_ROUNDS } from './GameTracker';
+import GameTracker from './GameTracker';
```

Add tracker state and a fetch effect alongside the existing seed-fetch effect (which stays unchanged):

```js
  const [trackerRounds, setTrackerRounds] = useState([]);
  const [trackerResults, setTrackerResults] = useState([]);

  // Real round-by-round history for the expanded game, replacing the
  // prototype's hardcoded SAMPLE_ROUNDS/SAMPLE_RESULTS. "Top 8" is always
  // appended client-side as the final pill — the backend only returns rounds
  // it actually has history for.
  useEffect(() => {
    if (!activeGame || !tournament?.id) { setTrackerRounds([]); setTrackerResults([]); return; }
    let active = true;
    fetch(`/api/game/${tournament.id}/${activeGame}/tracker`)
      .then((r) => (r.ok ? r.json() : { rounds: [], results: [] }))
      .then((data) => {
        if (!active) return;
        setTrackerRounds([...(data.rounds || []), { roundText: 'Top 8', roundInt: null, status: 'next' }]);
        setTrackerResults(data.results || []);
      })
      .catch(() => { if (active) { setTrackerRounds([{ roundText: 'Top 8', roundInt: null, status: 'next' }]); setTrackerResults([]); } });
    return () => { active = false; };
  }, [activeGame, tournament?.id]);
```

- [ ] **Step 3: Switch `selectedRound` from a fixed key to the round's text**

The prototype used static keys (`'r64'`, `'top8'`, ...). Replace with the round's
own `roundText`, which is unique per game's round list (including the
always-appended `'Top 8'` sentinel):

```diff
-  const [selectedRound, setSelectedRound] = useState('top8');
-  const openGame = (id) => { setActiveGame(id); setActiveView('bracket'); setSelectedRound('top8'); };
+  const [selectedRound, setSelectedRound] = useState('Top 8');
+  const openGame = (id) => { setActiveGame(id); setActiveView('bracket'); setSelectedRound('Top 8'); };
   const selectRound = (round) => {
-    if (round.key === 'top8') { setActiveView('bracket'); setSelectedRound('top8'); }
-    else { setActiveView('history'); setSelectedRound(round.key); }
+    if (round.roundText === 'Top 8') { setActiveView('bracket'); setSelectedRound('Top 8'); }
+    else { setActiveView('history'); setSelectedRound(round.roundText); }
   };
```

- [ ] **Step 4: Render the dynamic round-pill list**

Replace the `SAMPLE_ROUNDS.map(...)` pill-strip render with `trackerRounds.map(...)`,
keyed by `roundText` instead of `key`:

```diff
-                    <div className="wr-round-pills" role="tablist">
-                      {SAMPLE_ROUNDS.map((r) => (
-                        <button
-                          type="button"
-                          role="tab"
-                          key={r.key}
-                          aria-selected={selectedRound === r.key}
-                          className={`wr-round-pill wr-round-${r.status}${selectedRound === r.key ? ' selected' : ''}`}
-                          onClick={() => selectRound(r)}
-                        >
-                          <div className="wr-round-pill-label">{r.label}</div>
-                          <div className="wr-round-pill-status">{r.status}</div>
-                        </button>
-                      ))}
-                    </div>
+                    <div className="wr-round-pills" role="tablist">
+                      {trackerRounds.map((r) => (
+                        <button
+                          type="button"
+                          role="tab"
+                          key={r.roundText}
+                          aria-selected={selectedRound === r.roundText}
+                          className={`wr-round-pill wr-round-${r.status}${selectedRound === r.roundText ? ' selected' : ''}`}
+                          onClick={() => selectRound(r)}
+                        >
+                          <div className="wr-round-pill-label">{r.roundText}</div>
+                          <div className="wr-round-pill-status">{r.status}</div>
+                        </button>
+                      ))}
+                    </div>
```

(`.wr-round-pill-label` now shows the real round text, e.g. "Pools" or "Winners
Round 2", instead of the abbreviated "R64"/"R32" placeholders — long labels
wrap fine in the existing flex layout, no CSS change needed.)

- [ ] **Step 5: Pass real `results` into `GameTracker`**

```diff
-                      <GameTracker
-                        seeds={seeds}
-                        roundLabel={SAMPLE_ROUNDS.find((r) => r.key === selectedRound)?.resultsLabel}
-                      />
+                      <GameTracker
+                        seeds={seeds}
+                        results={trackerResults}
+                        roundLabel={selectedRound === 'Top 8' ? null : selectedRound}
+                      />
```

---

### Task 7: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `node --test test/`
Expected: the pre-existing 97/101 baseline plus 8 new passing tests (5 from
`test/live/bracket-history.test.js` + 3 from `test/live/tracker.test.js`) —
confirm the only failures are the same pre-existing 4 in
`test/live/upcoming.test.js` (stale schema, unrelated to this work).

- [ ] **Step 2: Seed some real history in the dev DB**

Run `node scripts/sync-live.js --all` against a tournament that's `is_live = 1`
with an active start.gg bracket, or hand-insert a couple of `bracket_history`
rows via `node -e "..."` (matching the pattern used in this plan's tests) if
no live event is available at verification time.

- [ ] **Step 3: Verify in the preview**

Start the dev server, open Tournaments, expand a tracked game. Confirm:
- Round pills show real round text (e.g. "Pools", "Winners Round 1") instead
  of the old "R64/R32/R16/QF" placeholders.
- Tapping an earlier round filters "Recent results" to that round and shows
  real winner/loser/score data.
- "Still alive" reflects real seed data minus anyone who's actually lost a
  tracked set.
- Tapping "Top 8" still shows the real, unchanged live Bracket / outright-picks
  flow.
- No console errors; no change to existing Top 8 market behavior.

- [ ] **Step 4: Push**

```bash
git push origin testing
```

---

## Self-Review

**Spec coverage:**
- Real round-by-round progress per game → Tasks 3–5 (poller writes, query, endpoint). ✓
- Still-alive list → Task 4 (`getGameTracker` `stillAlive`, derived from real seed + loss data). ✓
- Round pills double as Bracket/History nav, reachable after Top 8 too → carried over unchanged from the approved prototype; Task 6 only swaps the data source. ✓
- No new FM markets/stakes; `set_markets` untouched → Task 0 (separate table) + Task 3's explicit test asserting zero `set_markets` writes. ✓
- Pools collapse into one pill → Task 2 (`groupSetsIntoRounds`, tested). ✓
- Round labels from start.gg, not a fixed template → Task 6 Step 4 (`trackerRounds.map`, real `roundText`). ✓

**Placeholder scan:** No TBD/TODO; every code/command step is complete. Task 7 Step 2's "hand-insert rows if no live event is available" is a verification fallback, not an implementation placeholder.

**Type/name consistency:** `getGameTracker()` returns `{ rounds, results, stillAlive }` (Task 4) — consumed identically by the route (Task 5, `res.json(...)` passthrough) and the frontend (Task 6, `data.rounds`/`data.results`). `groupSetsIntoRounds()`'s output shape (`{ roundText, roundInt, phaseOrder, sets }`, Task 2) matches exactly what `processHistorySets()` consumes (Task 3). `selectedRound` changes from a static key to `roundText` string consistently across `openGame`, `selectRound`, and the pill render (Task 6, Steps 3–4).

---

## Notes for the implementer

- This plan assumes `testing` is the working branch (matches how prior features in this repo shipped — no separate feature branch).
- The `WaitingRoom.js`/`GameTracker.js` prototype referenced throughout is already in the working tree, uncommitted, from the brainstorming session — Task 6 modifies it in place rather than building from scratch.
- Per user preference (see project memory), push to `testing` after this lands so Render picks it up — Task 7 Step 4.
