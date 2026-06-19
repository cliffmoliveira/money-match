# Live Waiting Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Live page's boring "no live markets" empty state with a Waiting Room: a countdown to the next tracked tournament, per-game tabs, and the empty Top 8 bracket skeleton with highlighted waiting slots — flipping to the live view automatically when markets open.

**Architecture:** Backend gains one read-only function/endpoint (`getUpcoming` → `GET /api/live/upcoming`) returning the soonest active/upcoming tracked tournament + its games. The frontend adds a focused `WaitingRoom` component (reusing the existing `Bracket` and `Countdown`); `LiveBetting.js` renders it when there are zero markets. `Bracket` gains a `waiting` flag that pulses its empty `.bnode.tbd` slots.

**Tech Stack:** Express + SQLite (`db/db.js` async helpers), React (CRA / react-app-rewired), `node:test` for backend tests, existing `Bracket`/`Countdown` components and `tournamentLogos`/`gameLogos` utils.

---

## File Structure

- **`liveMarkets.js`** (modify) — add `getUpcoming()` query function + export it. Sits with the other live data functions (`getMarkets`, `getUserBets`).
- **`server.js`** (modify) — add `GET /api/live/upcoming` route next to the other `/api/live/*` routes (~line 528), calling `liveMarkets.getUpcoming()`.
- **`test/live/upcoming.test.js`** (create) — `node:test` for `getUpcoming()`.
- **`client/src/components/Bracket.js`** (modify) — add `waiting` prop → `bracket-waiting` class on the root.
- **`client/src/components/Bracket.css`** (modify) — pulse `.bracket-waiting .bnode.tbd`.
- **`client/src/components/WaitingRoom.js`** (create) — countdown + game tabs + empty bracket.
- **`client/src/components/WaitingRoom.css`** (create) — layout for the above.
- **`client/src/components/LiveBetting.js`** (modify) — fetch `/api/live/upcoming` in `refresh()`; render `<WaitingRoom>` in the `markets.length === 0` branch.

**Note on TDD:** The backend task is full TDD (`node:test`). The app has no React component test harness, so frontend tasks are implement-then-verify in the running preview (explicit verification steps included), per the spec's testing section.

---

### Task 1: Backend — `getUpcoming()` query (TDD)

**Files:**
- Modify: `liveMarkets.js` (add function + add to `module.exports`)
- Test: `test/live/upcoming.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/live/upcoming.test.js`:

```js
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// getUpcoming reads module-level db handle, so wire a fresh temp DB and require
// the module AFTER setting DATABASE_PATH (mirrors test/affiliate/helpers.js).
let db, lm, file;

before(async () => {
  file = path.join(os.tmpdir(), `mm-upcoming-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_PATH = file;
  delete require.cache[require.resolve('../../db/db')];
  delete require.cache[require.resolve('../../liveMarkets')];
  db = require('../../db/db');
  lm = require('../../liveMarkets');
  await db.runAsync(`CREATE TABLE tournaments (id INTEGER PRIMARY KEY, name TEXT, date TEXT, startgg_id TEXT, is_live INTEGER DEFAULT 0)`);
  await db.runAsync(`CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT)`);
  await db.runAsync(`CREATE TABLE players_games_tournaments (tournament_id INTEGER, game_id INTEGER, player_id INTEGER, seed_num INTEGER)`);
});

beforeEach(async () => {
  await db.runAsync('DELETE FROM players_games_tournaments');
  await db.runAsync('DELETE FROM games');
  await db.runAsync('DELETE FROM tournaments');
});

after(() => { try { fs.unlinkSync(file); } catch { /* ignore */ } });

async function addTournament(id, name, date, { isLive = 0 } = {}) {
  await db.runAsync('INSERT INTO tournaments (id, name, date, startgg_id, is_live) VALUES (?,?,?,?,?)',
    [id, name, date, `sgg-${id}`, isLive]);
}
async function addGame(id, name) { await db.runAsync('INSERT INTO games (id, name) VALUES (?,?)', [id, name]); }
async function trackGame(tournamentId, gameId) {
  await db.runAsync('INSERT INTO players_games_tournaments (tournament_id, game_id, player_id, seed_num) VALUES (?,?,?,1)',
    [tournamentId, gameId, 1]);
}

test('returns the soonest upcoming tournament that has tracked games', async () => {
  await addGame(10, 'Street Fighter 6');
  await addGame(11, 'TEKKEN 8');
  await addTournament(1, 'Later Major', '2099-12-31');
  await trackGame(1, 10);
  await addTournament(2, 'Sooner Major', '2099-01-01');
  await trackGame(2, 10);
  await trackGame(2, 11);

  const { tournament, games } = await lm.getUpcoming();
  assert.equal(tournament.id, 2);
  assert.equal(tournament.name, 'Sooner Major');
  assert.deepEqual(games.map((g) => g.name), ['Street Fighter 6', 'TEKKEN 8']);
});

test('skips a sooner tournament that has no tracked games', async () => {
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'No Games Major', '2099-01-01'); // no trackGame
  await addTournament(2, 'Has Games Major', '2099-06-01');
  await trackGame(2, 10);

  const { tournament } = await lm.getUpcoming();
  assert.equal(tournament.id, 2);
});

test('prefers a live tournament over a future-dated one', async () => {
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'Future Major', '2099-01-01');
  await trackGame(1, 10);
  await addTournament(2, 'Live Now Major', '2000-01-01', { isLive: 1 }); // past date but flagged live
  await trackGame(2, 10);

  const { tournament } = await lm.getUpcoming();
  assert.equal(tournament.id, 2);
});

test('returns null tournament when nothing is upcoming or live', async () => {
  await addGame(10, 'Street Fighter 6');
  await addTournament(1, 'Old Major', '2000-01-01'); // finished, not live
  await trackGame(1, 10);

  const result = await lm.getUpcoming();
  assert.equal(result.tournament, null);
  assert.deepEqual(result.games, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/live/upcoming.test.js`
Expected: FAIL — `lm.getUpcoming is not a function`.

- [ ] **Step 3: Implement `getUpcoming()` in `liveMarkets.js`**

Add this function near the other exported query functions (e.g. just before `module.exports`):

```js
// Read-only: the soonest active/upcoming tracked tournament that has tracked
// games, plus its games. Powers the Live page's "waiting room" before any Top 8
// markets exist. Returns { tournament: null, games: [] } when nothing is coming.
async function getUpcoming() {
  const tournament = await db.getAsync(
    `SELECT id, name, date FROM tournaments t
     WHERE startgg_id IS NOT NULL
       AND (is_live = 1 OR date(date) >= date('now','-1 day'))
       AND EXISTS (SELECT 1 FROM players_games_tournaments pgt WHERE pgt.tournament_id = t.id)
     ORDER BY is_live DESC, date(date) ASC
     LIMIT 1`
  );
  if (!tournament) return { tournament: null, games: [] };
  const games = await db.allAsync(
    `SELECT DISTINCT g.id, g.name
     FROM players_games_tournaments pgt
     JOIN games g ON g.id = pgt.game_id
     WHERE pgt.tournament_id = ?
     ORDER BY g.name`,
    [tournament.id]
  );
  return { tournament, games };
}
```

Then add `getUpcoming` to the `module.exports` object in `liveMarkets.js` (alongside `getMarkets`, `getUserBets`, etc.).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/live/upcoming.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add liveMarkets.js test/live/upcoming.test.js
git commit -m "feat(live): getUpcoming() — soonest tracked tournament + its games"
```

---

### Task 2: Backend — `GET /api/live/upcoming` route

**Files:**
- Modify: `server.js` (after the `/api/live/bets` GET handler, ~line 540)

- [ ] **Step 1: Add the route**

Insert after the `app.get('/api/live/bets', ...)` handler:

```js
// Read-only: the next tracked tournament + its games, for the Live page's
// pre-Top-8 "waiting room". No auth, no writes.
app.get('/api/live/upcoming', async (req, res) => {
  try {
    res.json(await liveMarkets.getUpcoming());
  } catch (err) {
    console.error('Error fetching upcoming tournament:', err.message);
    res.status(500).json({ error: 'Failed to fetch upcoming tournament' });
  }
});
```

- [ ] **Step 2: Smoke-test against the dev DB**

Run (with the backend running on :5000):
`curl -s http://localhost:5000/api/live/upcoming`
Expected: JSON `{ "tournament": {...} | null, "games": [...] }` (200). It must not 500.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(live): GET /api/live/upcoming endpoint"
```

---

### Task 3: Frontend — `Bracket` waiting highlight

**Files:**
- Modify: `client/src/components/Bracket.js` (signature ~line 145; root element ~line 255)
- Modify: `client/src/components/Bracket.css` (append)

- [ ] **Step 1: Add the `waiting` prop**

In `client/src/components/Bracket.js`, change the component signature:

```js
const Bracket = ({ markets = [], slip = {}, onPick, demoControls, waiting = false }) => {
```

And add the class to the root `.bracket-fit` element (the `return (` near line 255):

```jsx
    <div
      className={`bracket-fit${waiting ? ' bracket-waiting' : ''}`}
      ref={fitRef}
      style={{ height: dims.h ? dims.h * scale : undefined }}
    >
```

(Leave everything else unchanged. With `markets={[]}`, every cell already renders as a `.bnode.tbd` placeholder.)

- [ ] **Step 2: Append the highlight CSS**

Append to `client/src/components/Bracket.css`:

```css
/* Waiting room: pulse the empty slots so it's clear what we're waiting to fill */
.bracket-waiting .bnode.tbd {
  animation: bracketWait 1.8s ease-in-out infinite;
}
.bracket-waiting .bnode.tbd .bnode-head {
  color: var(--gold);
  letter-spacing: 0.04em;
}
@keyframes bracketWait {
  0%, 100% { border-color: var(--border-strong); box-shadow: 0 0 0 0 rgba(231, 180, 88, 0); }
  50%      { border-color: rgba(231, 180, 88, 0.55); box-shadow: 0 0 14px 0 rgba(231, 180, 88, 0.18); }
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/components/Bracket.js client/src/components/Bracket.css
git commit -m "feat(live): Bracket waiting flag pulses empty slots"
```

---

### Task 4: Frontend — `WaitingRoom` component

**Files:**
- Create: `client/src/components/WaitingRoom.js`
- Create: `client/src/components/WaitingRoom.css`

- [ ] **Step 1: Create `WaitingRoom.js`**

```jsx
import React, { useState } from 'react';
import './WaitingRoom.css';
import Bracket from './Bracket';
import Countdown from './Countdown';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';

// Small logo helpers that walk the asset candidates and fall back to text,
// mirroring the pattern in Home.js / LiveBetting.js.
const TournamentLogo = ({ name, height = 44 }) => {
  const [i, setI] = useState(0);
  const candidates = Object.values(getTournamentLogoSources(name)).filter(Boolean);
  const src = candidates[i];
  if (!src) return <span className="wr-tname-fallback">{name}</span>;
  return <img src={src} alt={getTournamentAlt(name)} style={getTournamentLogoStyle(name, height)}
    onError={() => setI((x) => (x + 1 < candidates.length ? x + 1 : x))} />;
};
const GameTabLogo = ({ name, height = 20 }) => {
  const [i, setI] = useState(0);
  const candidates = Object.values(getGameLogoSources(name)).filter(Boolean);
  const src = candidates[i];
  if (!src) return <>{name}</>;
  return <img src={src} alt={getGameAlt(name)} style={getGameLogoStyle(name, height)}
    onError={() => setI((x) => (x + 1 < candidates.length ? x + 1 : x))} />;
};

// Pre-Top-8 view: countdown to the tournament, per-game tabs, and the empty
// Top 8 bracket skeleton with highlighted waiting slots.
const WaitingRoom = ({ tournament, games = [] }) => {
  const [activeGame, setActiveGame] = useState(games[0]?.id ?? null);

  // The tournament date is a calendar day (UTC midnight); once it passes we
  // can't count down precisely, so show a standby status instead of a clock.
  const target = new Date(`${tournament.date}T00:00:00`).getTime();
  const started = !isNaN(target) && target <= Date.now();

  return (
    <div className="waiting-room">
      <div className="wr-header">
        <div className="wr-brand">
          <TournamentLogo name={tournament.name} />
          <div className="wr-title">
            <h2>{tournament.name}</h2>
            <p className="wr-sub">Top 8 bracket — markets open automatically when the bracket begins.</p>
          </div>
        </div>
        <div className="wr-clock">
          {started
            ? <div className="wr-standby">Top 8 hasn’t started yet — standing by…</div>
            : <Countdown date={tournament.date} />}
        </div>
      </div>

      {games.length > 1 && (
        <div className="wr-game-tabs">
          {games.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`filter-tab ${g.id === activeGame ? 'active' : ''}`}
              onClick={() => setActiveGame(g.id)}
            >
              <GameTabLogo name={g.name} /> <span>{g.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="wr-bracket">
        <Bracket markets={[]} waiting />
      </div>
    </div>
  );
};

export default WaitingRoom;
```

(Note: in pure-waiting mode the skeleton is identical for every game, so the
tabs set context/anticipation rather than changing the bracket. The selected
game becomes meaningful once that game's markets open and the parent flips to
the live view.)

- [ ] **Step 2: Create `WaitingRoom.css`**

```css
.waiting-room {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 22px;
}
.wr-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 18px; flex-wrap: wrap; margin-bottom: 18px;
}
.wr-brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.wr-title h2 {
  font-family: 'Saira', sans-serif; font-weight: 800; font-size: 22px;
  margin: 0; color: var(--text);
}
.wr-sub { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
.wr-tname-fallback { font-family: 'Saira', sans-serif; font-weight: 800; font-size: 20px; color: var(--text); }
.wr-clock { flex-shrink: 0; }
.wr-standby {
  font-family: 'Saira', sans-serif; font-weight: 700; font-size: 14px;
  color: var(--gold); background: var(--gold-tint);
  border: 1px solid rgba(231, 180, 88, 0.28); border-radius: 10px; padding: 10px 14px;
}
.wr-game-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
.wr-game-tabs .filter-tab { display: inline-flex; align-items: center; gap: 8px; }
.wr-bracket { overflow-x: auto; }

@media (max-width: 760px) {
  .waiting-room { padding: 14px; }
  .wr-header { gap: 12px; }
  .wr-title h2 { font-size: 19px; }
}
```

(`.filter-tab`, `--card`, `--gold`, `--gold-tint`, `--muted`, `--border` already
exist in the app's CSS.)

- [ ] **Step 3: Commit**

```bash
git add client/src/components/WaitingRoom.js client/src/components/WaitingRoom.css
git commit -m "feat(live): WaitingRoom component (countdown + game tabs + empty bracket)"
```

---

### Task 5: Frontend — wire WaitingRoom into the Live page

**Files:**
- Modify: `client/src/components/LiveBetting.js` (import ~line 3; state ~line 31; `refresh()` ~line 51-67; empty-state render ~line 308-312)

- [ ] **Step 1: Import WaitingRoom**

After `import Bracket from './Bracket';` add:

```js
import WaitingRoom from './WaitingRoom';
```

- [ ] **Step 2: Add `upcoming` state**

After `const [markets, setMarkets] = useState([]);` add:

```js
  const [upcoming, setUpcoming] = useState(null);
```

- [ ] **Step 3: Fetch upcoming in `refresh()`**

Replace the `Promise.all` block and the `if (mRes.ok)...` lines in `refresh()` with:

```js
      const [mRes, wRes, bRes, uRes] = await Promise.all([
        fetch('/api/live/markets'),
        fetch(`/api/wallet?userId=${userId}`),
        fetch(`/api/live/bets?userId=${userId}`),
        fetch('/api/live/upcoming'),
      ]);
      if (mRes.ok) setMarkets(await mRes.json());
      if (wRes.ok) setBalanceCents((await wRes.json()).balanceCents);
      if (bRes.ok) setMyBets(await bRes.json());
      if (uRes.ok) setUpcoming(await uRes.json());
```

- [ ] **Step 4: Render WaitingRoom in the empty branch**

Replace the `markets.length === 0 ? ( ... )` empty block (the `.live-empty` div) with:

```jsx
        {markets.length === 0 ? (
          upcoming && upcoming.tournament ? (
            <WaitingRoom tournament={upcoming.tournament} games={upcoming.games} />
          ) : (
            <div className="live-empty">
              <h2>No live markets right now</h2>
              <p>Markets open automatically when a tracked tournament reaches Top 8.</p>
            </div>
          )
        ) : (
```

(Leave the `: ( ...groups... )` live branch unchanged.)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/LiveBetting.js
git commit -m "feat(live): show WaitingRoom on the Live page when no markets are open"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the backend test suite**

Run: `node --test test/live`
Expected: PASS (4 tests). Also run `npm run test:affiliate` to confirm nothing else broke.

- [ ] **Step 2: Verify the waiting state in the preview**

Start the dev server, open the Live page while no markets are open (the default dev state). Confirm:
- The WaitingRoom renders with the tournament name + a ticking countdown (or the "standing by" status if the date has passed).
- Game tabs appear when the tournament tracks >1 game and switch active state on click.
- The empty Top 8 bracket renders with **pulsing gold waiting slots**.
- No horizontal page overflow at 412px width (bracket scrolls within its own container).

- [ ] **Step 3: Verify the flip to live**

With `ENABLE_DEMO=1`, click **Seed demo markets** (or `POST /api/live/seed-demo`). Within one poll cycle (≤15s) the WaitingRoom is replaced by the live bracket. Then **Reset** → it returns to the WaitingRoom. Confirm no console errors during the transition.

- [ ] **Step 4: Confirm the failure fallback**

Temporarily point the fetch at a bad path (or stop the backend) and confirm the page falls back to the plain "No live markets right now" text rather than crashing. Revert.

---

## Self-Review

**Spec coverage:**
- Waiting Room replaces empty state → Tasks 4 + 5. ✓
- Empty skeleton, fills live → `Bracket markets={[]}` + parent flip on poll (Task 5, verified Task 6 Step 3). ✓
- Countdown to tournament date + past-zero standby → Task 4 (`started` branch). ✓
- One game + tabs (default first) → Task 4 (`wr-game-tabs`, `activeGame`). ✓
- Soonest active tournament + its games → Task 1 query. ✓
- One read-only endpoint, no new schema → Tasks 1-2. ✓
- Highlight waiting spots → Task 3 pulse. ✓
- Edge/failure fallback → Task 5 (null-tournament branch) + Task 6 Step 4. ✓
- Tests → Task 1 (backend) + Task 6 (frontend manual). ✓

**Placeholder scan:** No TBD/TODO; every code/command step is complete. ✓

**Type/name consistency:** `getUpcoming` returns `{ tournament, games }` (Task 1) and is consumed identically in Task 2 (route) and Task 5 (`upcoming.tournament` / `upcoming.games`). `waiting` prop defined in Task 3, passed in Task 4. `WaitingRoom({ tournament, games })` defined Task 4, called with those exact props Task 5. ✓

---

## Notes for the implementer

- Work on the `live-waiting-room` branch (already created off `affiliate-mock-sportsbook`).
- This branch does **not** include password-reset / mobile-nav / eye-toggle work — those live on sibling branches; don't expect them here.
- The tunnel that's used for on-the-go testing builds from a separate `testing` branch; to see this feature in the tunnel, merge `live-waiting-room` into `testing` and rebuild (out of scope for this plan — ask the user).
