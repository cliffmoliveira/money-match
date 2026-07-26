require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

// Resolve the database path from environment variables or use default
const dbPath = path.resolve(process.env.DATABASE_PATH || './database.db');

// One-time seed hook: if "<dbPath>.seed" exists on disk (e.g. a migration
// snapshot uploaded onto a persistent volume out of band), swap it into place
// BEFORE opening the database — while nothing holds the file open. Stale WAL/SHM
// from any prior DB are cleared so SQLite won't replay an old journal over it.
// Self-consuming: the rename removes the .seed file, so it runs at most once.
const fs = require('fs');
const seedPath = `${dbPath}.seed`;
if (fs.existsSync(seedPath)) {
  for (const ext of ['-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${ext}`); } catch (_) { /* nothing to clear */ }
  }
  fs.renameSync(seedPath, dbPath);
  console.log(`Seeded database from ${seedPath}`);
}

// better-sqlite3 is a synchronous, in-process driver: no callback queue and no
// libuv threadpool hop per statement, so the write-heavy live-betting path runs
// much faster under load than node-sqlite3. We keep the SAME promise-returning
// interface (getAsync/allAsync/runAsync/closeAsync) the rest of the app already
// uses, so this is a drop-in swap — every `await db.getAsync(...)` keeps working
// and the global write mutex in txn.js still serializes transactions correctly.
const db = new Database(dbPath);
console.log(`Connected to the SQLite database at ${dbPath}`);

// Same tuning as before: WAL lets readers run alongside the single writer,
// busy_timeout makes a contended writer wait rather than throw, and
// synchronous=NORMAL (safe with WAL) avoids an fsync per commit.
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

// Follow-a-competitor: lets a user track players who already appear in the
// ingested start.gg entrant/set data. Created here (not a one-off
// migrate-*.js script) so it's live on Render immediately after this deploy.
// No FOREIGN KEY declarations: better-sqlite3 defaults PRAGMA foreign_keys=ON,
// which makes SQLite resolve a referenced table at DML-compile time for ANY
// cascading delete against it — even unrelated ones, like `DELETE FROM users`
// in a test harness that only creates a partial schema. Referential integrity
// is instead enforced at the application layer (followPlayer() checks the
// player exists before inserting), matching how set_markets/set_bets do it.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, player_id)
    )
  `);
} catch (e) { console.error('[boot] follows table setup failed:', e.message); }

// Tiny generic key/value store for small persisted bits of app state that
// don't warrant their own table (e.g. "when did the daily Start.gg sync last
// actually run" - see scheduleStartGgSync in server.js).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
} catch (e) { console.error('[boot] app_state table setup failed:', e.message); }

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
  // getMarkets' unresolvedSetsSql correlates on (tournament_id, updated_at)
  // once per tournament row - without this, each call is a full scan of a
  // table that only grows (144k+ rows and counting).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bracket_history_tournament ON bracket_history(tournament_id, updated_at)`);
} catch (e) { console.error('[boot] bracket_history table setup failed:', e.message); }

// players.photo_url: start.gg entrant profile photo, backfilled during
// ingestion (sync-live.js, sync-upcoming.js, backfill-top8-2026.js,
// syncStartgg.js, backfill-results.js). Guarded by a column-exists check
// rather than try/catch on ALTER, so it doesn't repeat a "duplicate column"
// error on every boot.
try {
  const cols = db.prepare("PRAGMA table_info(players)").all();
  if (cols.length && !cols.some((c) => c.name === 'photo_url')) {
    db.exec('ALTER TABLE players ADD COLUMN photo_url TEXT');
    console.log('[boot] players.photo_url added');
  }
} catch (e) { console.error('[boot] players.photo_url setup failed:', e.message); }

// players_games_tournaments.placement: final tournament standing (1 = 1st,
// 9 = 9th, etc.), pulled post-event by scripts/sync-standings.js for entrants
// who placed outside the live-tracked Top 8. Same guarded-ALTER pattern as
// players.photo_url above.
try {
  const cols = db.prepare("PRAGMA table_info(players_games_tournaments)").all();
  if (cols.length && !cols.some((c) => c.name === 'placement')) {
    db.exec('ALTER TABLE players_games_tournaments ADD COLUMN placement INTEGER');
    console.log('[boot] players_games_tournaments.placement added');
  }
} catch (e) { console.error('[boot] players_games_tournaments.placement setup failed:', e.message); }

// set_markets.startgg_event_id / startgg_event_name: which start.gg EVENT a
// market's set actually came from. Existing columns (tournament_id, game_id)
// key by videogame, not event - two different events at the same tournament
// can share a videogame (a real competitive bracket plus a same-game bonus
// minigame/side-activity), and without an event-level key their sets get
// silently merged into one bracket view. isSideEvent() name-matches known
// offenders (confirmed twice: "Side Event Sunday", then "Tekken Ball" at
// VSFighting XIV), but that only ever catches a pattern after someone
// notices the merge. Persisting the real event lets diagnosePreviewOnlyGames'
// sibling check below catch ANY future same-videogame-different-event merge
// on sight, regardless of what the event happens to be named.
try {
  const cols = db.prepare("PRAGMA table_info(set_markets)").all();
  if (cols.length && !cols.some((c) => c.name === 'startgg_event_id')) {
    db.exec('ALTER TABLE set_markets ADD COLUMN startgg_event_id TEXT');
    db.exec('ALTER TABLE set_markets ADD COLUMN startgg_event_name TEXT');
    console.log('[boot] set_markets.startgg_event_id / startgg_event_name added');
  }
} catch (e) { console.error('[boot] set_markets.startgg_event_id setup failed:', e.message); }

// READ-ONLY diagnostic, round 4: a (tournament, game) pair whose real
// (non-preview, non-void) set_markets rows carry startgg_event_id from more
// than one distinct start.gg event. Only rows written after this migration
// carry an event id, so this can't see pre-existing merges (like the
// VSFighting XIV Tekken Ball one, already cleaned up by hand) - it's a
// forward-looking tripwire for the next one. Logged only, callable per
// live-sync cycle the same way as diagnosePreviewOnlyGames.
db.diagnoseMultiEventGames = function diagnoseMultiEventGames(logPrefix = '[boot]') {
  try {
    const rows = db.prepare(
      `SELECT t.name AS tournament_name, t.date, g.name AS game_name,
              GROUP_CONCAT(DISTINCT sm.startgg_event_name) AS event_names,
              COUNT(DISTINCT sm.startgg_event_id) AS event_count
       FROM set_markets sm
       JOIN tournaments t ON t.id = sm.tournament_id
       JOIN games g ON g.id = sm.game_id
       WHERE sm.startgg_set_id NOT LIKE 'preview_%' AND sm.state != 'void'
         AND sm.startgg_event_id IS NOT NULL
       GROUP BY t.id, g.id
       HAVING event_count > 1
       ORDER BY t.date DESC, g.name`
    ).all();
    if (rows.length) {
      console.log(`${logPrefix}[diagnostic] ${rows.length} game(s) whose real markets span more than one start.gg event (likely a side-event/minigame merge):`);
      for (const row of rows) {
        console.log(`${logPrefix}[diagnostic]   "${row.tournament_name}" (${row.date}) — ${row.game_name}: ${row.event_count} events (${row.event_names})`);
      }
    }
    return rows;
  } catch (_) {
    return []; // table may not exist yet on a fresh DB
  }
};
db.diagnoseMultiEventGames();

// Ensure "KOF XV & SAMSHO at EVO 2026 BYOC" (Start.gg id 881081) exists so the
// live poller picks it up. Idempotent — no-op if already present.
try {
  const EVO_2026_LOGO = 'https://images.start.gg/images/tournament/846933/image-bd9b974eaa96aa7802426a122072b4d9.jpg';
  const existing = db.prepare('SELECT id FROM tournaments WHERE startgg_id = 881081').get();
  if (!existing) {
    db.prepare(
      `INSERT INTO tournaments (name, date, city, country, startgg_id, is_live, logo_url)
       VALUES ('KOF XV & SAMSHO at EVO 2026 BYOC', '2026-06-26', 'Las Vegas', 'US', 881081, 1, ?)`
    ).run(EVO_2026_LOGO);
    console.log('[boot] inserted KOF XV & SAMSHO at EVO 2026 BYOC tournament');
  } else if (!existing.logo_url) {
    db.prepare('UPDATE tournaments SET logo_url = ? WHERE startgg_id = 881081').run(EVO_2026_LOGO);
    console.log('[boot] backfilled Evo logo for KOF XV & SAMSHO at EVO 2026 BYOC');
  }
  for (const [name, startggId] of [['SAMURAI SHODOWN', 3568], ['The King of Fighters XV', 36963]]) {
    const g = db.prepare('SELECT id FROM games WHERE startgg_id = ? OR name = ?').get(startggId, name);
    if (!g) {
      db.prepare('INSERT INTO games (name, startgg_id) VALUES (?, ?)').run(name, startggId);
      console.log(`[boot] inserted game: ${name}`);
    }
  }
} catch (e) { console.error('[boot] KOF/SAMSHO seed failed:', e.message); }

// Void any stale preview_* projection markets left over from pre-tournament
// seeding. Once real start.gg sets arrive they replace these; keeping them open
// creates duplicate bracket cards. Runs synchronously at boot so Render picks
// it up on the next deploy without manual DB intervention.
try {
  const { changes } = db.prepare(
    `UPDATE set_markets SET state='void'
     WHERE startgg_set_id LIKE 'preview_%' AND state NOT IN ('settled','void')`
  ).run();
  if (changes) console.log(`[boot] voided ${changes} stale preview market(s)`);
} catch (_) { /* table may not exist yet on a fresh DB */ }

// Remove duplicate historical set_markets rows. scripts/backfill-top8-2026.js
// writes each set under startgg_set_id = 'hist-<realSetId>' so it never
// collides with the live poller's own row (startgg_set_id = '<realSetId>')
// for a tournament that was ALSO tracked live during the event -- but that
// means a set covered by both ends up as two rows with the identical result,
// showing e.g. "Grand Final" and "Grand Final Reset" twice on the bracket.
// Only removes the 'hist-' duplicate when a live-tracked sibling row already
// exists for the same real set, and only when it has zero set_bets attached
// (backfill rows are inserted pre-settled and never accept bets, but this is
// a hard safety check, not an assumption) -- anything with bets is left
// alone and logged for manual review instead of silently dropped.
try {
  const dupes = db.prepare(
    `SELECT hist.id AS hist_id, hist.startgg_set_id AS hist_set_id
     FROM set_markets hist
     JOIN set_markets live
       ON live.tournament_id = hist.tournament_id
      AND live.game_id = hist.game_id
      AND live.startgg_set_id = SUBSTR(hist.startgg_set_id, 6)
     WHERE hist.startgg_set_id LIKE 'hist-%'`
  ).all();
  let removed = 0;
  for (const d of dupes) {
    const { c: betCount } = db.prepare('SELECT COUNT(*) AS c FROM set_bets WHERE market_id = ?').get(d.hist_id);
    if (betCount > 0) {
      console.warn(`[boot] skipping duplicate historical market ${d.hist_id} (${d.hist_set_id}) — has ${betCount} bet(s) attached, needs manual review`);
      continue;
    }
    db.prepare('DELETE FROM set_markets WHERE id = ?').run(d.hist_id);
    removed++;
  }
  if (removed) console.log(`[boot] removed ${removed} duplicate historical set_markets row(s) (backfill duplicated a live-tracked set)`);
} catch (_) { /* table may not exist yet on a fresh DB */ }

// READ-ONLY diagnostic: report set_markets that are stuck open/closed/pending
// (never settled or voided) for tournaments whose date is well in the past,
// plus the 'placed' (unsettled) set_bets riding on them. Logged only — no
// rows are changed here. Surfaced because of stuck "Pending"/"LIVE" picks
// found on the Home page for a tournament whose bracket already concluded.
try {
  const stuck = db.prepare(
    `SELECT t.id AS tournament_id, t.name AS tournament_name, t.date,
            sm.id AS market_id, sm.state AS market_state, sm.round_text,
            p1.name AS p1_name, p2.name AS p2_name,
            (SELECT COUNT(*) FROM set_bets WHERE market_id = sm.id AND state = 'placed') AS stuck_bets,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM set_bets WHERE market_id = sm.id AND state = 'placed') AS stuck_cents
     FROM set_markets sm
     JOIN tournaments t ON t.id = sm.tournament_id
     LEFT JOIN players p1 ON p1.id = sm.player1_id
     LEFT JOIN players p2 ON p2.id = sm.player2_id
     WHERE sm.state NOT IN ('settled', 'void')
       AND date(t.date) < date('now', '-3 day')
     ORDER BY t.date DESC, sm.id`
  ).all();
  if (stuck.length) {
    const byTournament = new Map();
    for (const row of stuck) {
      const key = row.tournament_name;
      if (!byTournament.has(key)) byTournament.set(key, { date: row.date, markets: 0, stuckBets: 0, stuckCents: 0 });
      const agg = byTournament.get(key);
      agg.markets += 1;
      agg.stuckBets += row.stuck_bets;
      agg.stuckCents += row.stuck_cents;
    }
    console.log(`[boot][diagnostic] ${stuck.length} set_markets stuck open/closed/pending past their tournament date:`);
    for (const [name, agg] of byTournament) {
      console.log(`[boot][diagnostic]   "${name}" (${agg.date}) — ${agg.markets} stuck market(s), ${agg.stuckBets} unsettled set_bets totaling ${(agg.stuckCents / 100).toFixed(2)} FM`);
    }
    for (const row of stuck) {
      if (row.stuck_bets > 0) {
        console.log(`[boot][diagnostic]     market ${row.market_id} state=${row.market_state} round="${row.round_text || ''}" ${row.p1_name || '?'} vs ${row.p2_name || '?'} — ${row.stuck_bets} placed bet(s), ${(row.stuck_cents / 100).toFixed(2)} FM`);
      }
    }
  } else {
    console.log('[boot][diagnostic] no set_markets stuck open/closed/pending past their tournament date');
  }
} catch (_) { /* table may not exist yet on a fresh DB */ }

// READ-ONLY diagnostic, round 2: the opposite anomaly — set_bets still
// 'placed' whose market HAS already resolved ('settled' or 'void'). This is
// the pattern actually found on Home (the market is already settled, but
// these specific bet rows never got updated/paid by settleMarket/voidMarket).
try {
  const orphaned = db.prepare(
    `SELECT sb.id AS bet_id, sb.user_id, sb.amount_cents, sb.picked_player_id, sb.created_at,
            sm.id AS market_id, sm.state AS market_state, sm.winner_id, sm.round_text, sm.settled_at,
            t.id AS tournament_id, t.name AS tournament_name, t.date,
            p1.name AS p1_name, p2.name AS p2_name
     FROM set_bets sb
     JOIN set_markets sm ON sm.id = sb.market_id
     JOIN tournaments t ON t.id = sm.tournament_id
     LEFT JOIN players p1 ON p1.id = sm.player1_id
     LEFT JOIN players p2 ON p2.id = sm.player2_id
     WHERE sb.state = 'placed' AND sm.state IN ('settled', 'void')
     ORDER BY t.date DESC, sb.id`
  ).all();
  if (orphaned.length) {
    const totalCents = orphaned.reduce((s, r) => s + r.amount_cents, 0);
    console.log(`[boot][diagnostic] ${orphaned.length} set_bets still 'placed' on an already-resolved market, totaling ${(totalCents / 100).toFixed(2)} FM:`);
    for (const row of orphaned) {
      console.log(`[boot][diagnostic]     bet ${row.bet_id} user=${row.user_id} amount=${(row.amount_cents / 100).toFixed(2)}FM picked_player=${row.picked_player_id} created_at=${row.created_at} | market ${row.market_id} state=${row.market_state} winner_id=${row.winner_id} settled_at=${row.settled_at || ''} round="${row.round_text || ''}" ${row.p1_name || '?'} vs ${row.p2_name || '?'} | tournament ${row.tournament_id} "${row.tournament_name}" (${row.date})`);
    }
  } else {
    console.log("[boot][diagnostic] no orphaned set_bets ('placed' on an already-resolved market)");
  }
} catch (_) { /* table may not exist yet on a fresh DB */ }

// READ-ONLY diagnostic, round 3: a (tournament, game) pair whose ONLY
// set_markets rows are preview_* projections (seeding-based placeholders
// voided the moment a real bracket appears elsewhere) and has zero real
// markets, for a tournament that started within the last 3 days. Surfaces
// the exact shape of a real production bug found at VSFighting XIV: 13 of
// ~15 non-headline games at a 26-event major never got real Top-8 markets
// because isGameFullyResolved wrongly treated a voided preview as proof the
// real bracket had already run, permanently stopping the poller from ever
// fetching that game's real data again (fixed in scripts/sync-live.js, but
// this stays as a tripwire for any future variant of the same shape). Logged
// only — callable again per live-sync cycle via db.diagnosePreviewOnlyGames,
// not just at boot, so it surfaces within a minute instead of the next deploy.
db.diagnosePreviewOnlyGames = function diagnosePreviewOnlyGames(logPrefix = '[boot]') {
  try {
    const stuck = db.prepare(
      `SELECT t.id AS tournament_id, t.name AS tournament_name, t.date,
              g.id AS game_id, g.name AS game_name, COUNT(*) AS preview_count
       FROM set_markets sm
       JOIN tournaments t ON t.id = sm.tournament_id
       JOIN games g ON g.id = sm.game_id
       WHERE sm.startgg_set_id LIKE 'preview_%'
         AND date(t.date) BETWEEN date('now', '-3 day') AND date('now')
         AND NOT EXISTS (
           SELECT 1 FROM set_markets sm2
           WHERE sm2.tournament_id = sm.tournament_id AND sm2.game_id = sm.game_id
             AND sm2.startgg_set_id NOT LIKE 'preview_%'
         )
       GROUP BY t.id, g.id
       ORDER BY t.date DESC, g.name`
    ).all();
    if (stuck.length) {
      console.log(`${logPrefix}[diagnostic] ${stuck.length} game(s) with only preview_* markets (no real bracket data yet) at a tournament started within the last 3 days:`);
      for (const row of stuck) {
        console.log(`${logPrefix}[diagnostic]   "${row.tournament_name}" (${row.date}) — ${row.game_name}: ${row.preview_count} preview market(s), 0 real`);
      }
    }
    return stuck;
  } catch (_) {
    return []; // table may not exist yet on a fresh DB
  }
};
db.diagnosePreviewOnlyGames();

// Cache prepared statements by SQL text. SQLite auto-reprepares on schema
// changes, so cached statements stay valid across migrations.
const stmtCache = new Map();
function prepare(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) { stmt = db.prepare(sql); stmtCache.set(sql, stmt); }
  return stmt;
}

// node-sqlite3 was lenient about bind values; better-sqlite3 only accepts
// numbers, strings, bigints, buffers, and null. Coerce the two values the
// codebase might pass (undefined / booleans) so call sites don't have to change.
function bindArgs(params) {
  return params.map((p) => (p === undefined ? null : p === true ? 1 : p === false ? 0 : p));
}

// Transaction control / pragmas / vacuum don't bind params and aren't ordinary
// prepared-and-run statements — route them through exec().
const EXEC_RE = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ATTACH|DETACH)\b/i;

// Promise-returning wrappers (the interface the rest of the app depends on).
db.allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    try { resolve(prepare(sql).all(...bindArgs(params))); }
    catch (err) { console.error('Error executing query:', err.message); reject(err); }
  });

db.getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    try { resolve(prepare(sql).get(...bindArgs(params))); }
    catch (err) { console.error('Error fetching row:', err.message); reject(err); }
  });

db.runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    try {
      if (params.length === 0 && EXEC_RE.test(sql)) {
        db.exec(sql);
        resolve({ lastID: 0, changes: 0 });
      } else {
        const info = prepare(sql).run(...bindArgs(params));
        // Match node-sqlite3's `this` shape: lastID + changes.
        resolve({ lastID: Number(info.lastInsertRowid), changes: info.changes });
      }
    } catch (err) { console.error('Error running query:', err.message); reject(err); }
  });

db.closeAsync = () =>
  new Promise((resolve) => {
    db.close();
    console.log('Database connection closed.');
    resolve();
  });

module.exports = db;
