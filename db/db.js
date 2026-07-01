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
