/**
 * Live replay + simulation harness.
 *
 * Replays a COMPLETED event's Top 8 through the live lifecycle (state 1 -> 2 -> 3)
 * against a throwaway DB copy, driving it through the real poller code
 * (processTournamentEvents) while simulated users place bets on open markets.
 * This exercises — with REAL Start.gg data — the parts that a finished event
 * can't on its own and that only a genuinely in-progress event otherwise would:
 *   - markets opening (state 1), closing (state 2) and settling (state 3)
 *   - winnerId -> player mapping on real entrant ids
 *   - Grand Final + Grand Final Reset handling
 *   - parimutuel settlement + the rake-funded house cap, end to end
 *
 * It does NOT reproduce real wall-clock timing or the half-filled "pending" path
 * (real data has every entrant known up front) — those still want a live event.
 *
 * Usage:
 *   node scripts/replay-live.js [startggId] [gameNameSubstr]
 *     defaults: 751366 (Evo 2025); auto-picks an event that has a Grand Final
 *     Reset (so that path is covered), else any event with a Grand Final.
 *
 * Leaves db/database.replay.db in place (gitignored) so it can be inspected /
 * loaded in the preview; delete it when done.
 */
const fs = require('fs');
const path = require('path');

// Run against a fresh copy so the real DB is never touched.
const SRC = process.env.SRC_DB || path.resolve(__dirname, '..', 'db', 'database.db');
const REPLAY = path.resolve(__dirname, '..', 'db', 'database.replay.db');
fs.copyFileSync(SRC, REPLAY);
process.env.DATABASE_PATH = REPLAY;
process.env.DISABLE_SYNC = '1';
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const db = require('../db/db');
const wallet = require('../wallet');
const lm = require('../liveMarkets');
const { processTournamentEvents } = require('./sync-live');
const { startgg } = require('../startggClient');

const TID = Number(process.argv[2] || 751366);
const GAME_FILTER = process.argv[3] || null;
const NUM_USERS = 6;

const isGF = (t) => /grand final/i.test(t || '');
const isReset = (t) => /grand final reset/i.test(t || '');
const usd = (c) => `$${(c / 100).toFixed(2)}`;

const PHASES_Q = `query($id:ID!){tournament(id:$id){id name events{id name videogame{id name} phases{id phaseOrder}}}}`;
const SETS_Q = `query($eventId:ID!,$phaseId:ID!,$page:Int!,$perPage:Int!){event(id:$eventId){sets(page:$page,perPage:$perPage,sortType:STANDARD,filters:{phaseIds:[$phaseId]}){pageInfo{totalPages} nodes{id state fullRoundText winnerId round phaseGroup{id} slots{entrant{id name seeds{seedNum}} standing{stats{score{value}}}}}}}}`;

async function fetchFinalsSets(eventId, phaseId) {
  const all = [];
  for (let page = 1; page <= 6; page++) {
    const d = await startgg(SETS_Q, { eventId, phaseId, page, perPage: 50 });
    const conn = d && d.event && d.event.sets;
    const nodes = (conn && conn.nodes) || [];
    all.push(...nodes);
    if (nodes.length < 50 || page >= ((conn && conn.pageInfo && conn.pageInfo.totalPages) || 1)) break;
  }
  return all;
}

// Pick an event whose finals phase has a Grand Final; prefer one that also had a
// Reset so that path is exercised.
async function pickEvent() {
  const d = await startgg(PHASES_Q, { id: TID });
  const t = d && d.tournament;
  const events = (t && t.events) || [];
  const candidates = GAME_FILTER
    ? events.filter((e) => ((e.videogame && e.videogame.name) || '').toLowerCase().includes(GAME_FILTER.toLowerCase()))
    : events;
  let fallback = null;
  for (const ev of candidates) {
    const phases = ev.phases || [];
    if (!phases.length) continue;
    const finalPhase = phases.reduce((a, b) => ((b.phaseOrder ?? 0) > (a.phaseOrder ?? 0) ? b : a));
    const sets = await fetchFinalsSets(ev.id, finalPhase.id);
    if (!sets.some((s) => isGF(s.fullRoundText))) continue;
    if (sets.some((s) => isReset(s.fullRoundText))) return { tname: t.name, ev, sets };
    if (!fallback) fallback = { tname: t.name, ev, sets };
  }
  if (fallback) return fallback;
  throw new Error('No event with a Grand Final found');
}

// Approximate bracket play order: ordinary rounds by depth, then Grand Final,
// then its Reset last.
function orderForPlay(sets) {
  const rank = (s) => (isReset(s.fullRoundText) ? 3 : isGF(s.fullRoundText) ? 2 : 1);
  return sets.slice().sort((a, b) => rank(a) - rank(b) || Math.abs(a.round || 0) - Math.abs(b.round || 0));
}

(async () => {
  console.log(`Replay harness -> tournament ${TID}${GAME_FILTER ? ' / ' + GAME_FILTER : ''}\n`);
  const { tname, ev, sets: raw } = await pickEvent();
  const gameName = (ev.videogame && ev.videogame.name) || '?';
  const ordered = orderForPlay(raw);
  const realSets = ordered.filter((s) => s.slots?.[0]?.entrant?.id && s.slots?.[1]?.entrant?.id);
  console.log(`Event: ${tname} — ${gameName}`);
  console.log(`Finals sets: ${ordered.length} (${realSets.length} with two real entrants) | Reset present: ${ordered.some((s) => isReset(s.fullRoundText)) ? 'YES' : 'no'}\n`);

  // Our tournaments row + simulated, funded users.
  let tRow = await db.getAsync('SELECT id FROM tournaments WHERE startgg_id = ?', [TID]);
  if (!tRow) { const r = await db.runAsync('INSERT INTO tournaments (name, date, startgg_id, is_live) VALUES (?,?,?,1)', [tname, '2025-01-01', TID]); tRow = { id: r.lastID }; }
  await db.runAsync('UPDATE tournaments SET is_live = 1 WHERE id = ?', [tRow.id]);

  // Clean slate for the live-betting tables — the copied DB may carry demo rows,
  // which would otherwise skew the house bankroll and money-conservation checks.
  await db.runAsync('DELETE FROM set_bets');
  await db.runAsync('DELETE FROM set_markets');

  const simUsers = (await db.allAsync('SELECT id FROM users ORDER BY id LIMIT ?', [NUM_USERS])).map((u) => u.id);
  for (const u of simUsers) await db.runAsync('UPDATE users SET balance_cents = 100000 WHERE id = ?', [u]);
  const startTotal = NUM_USERS * 100000;

  const stateOf = ordered.map(() => 1);
  const betDone = new Set();
  let opened = 0, closed = 0, settled = 0, bets = 0, wagered = 0, minBankroll = Infinity;

  const poll = async () => {
    const payload = { id: ev.id, name: ev.name, videogame: ev.videogame, sets: { nodes: ordered.map((s, i) => ({ ...s, state: stateOf[i] })) } };
    const s = await processTournamentEvents(tRow, [payload]);
    opened += s.opened; closed += s.closed; settled += s.settled;
    // Simulated betting on any newly-open market.
    const open = await db.allAsync("SELECT * FROM set_markets WHERE tournament_id = ? AND state = 'open'", [tRow.id]);
    for (const m of open) {
      if (betDone.has(m.id)) continue;
      betDone.add(m.id);
      for (const u of simUsers) {
        if (Math.random() < 0.45) continue;
        const playerId = Math.random() < 0.5 ? m.player1_id : m.player2_id;
        if (!playerId) continue;
        const amountCents = (1 + Math.floor(Math.random() * 20)) * 500;
        try { await lm.placeBet({ userId: u, marketId: m.id, playerId, amountCents }); bets++; wagered += amountCents; } catch { /* ignore funds */ }
      }
    }
    minBankroll = Math.min(minBankroll, await lm.houseBankrollCents());
  };

  await poll();                              // tick 0: all upcoming -> open + bet
  for (let i = 0; i < ordered.length; i++) {
    stateOf[i] = 2; await poll();            // in progress -> close
    stateOf[i] = 3; await poll();            // completed -> settle
  }
  await poll();                              // idempotency: re-run final state, expect no change

  // ---- Verifications ----
  const fails = [];
  const markets = await db.allAsync('SELECT * FROM set_markets WHERE tournament_id = ?', [tRow.id]);
  const bySet = new Map(markets.map((m) => [m.startgg_set_id, m]));

  for (const s of realSets) {
    const m = bySet.get(String(s.id));
    if (!m) { fails.push(`no market for set ${s.id} (${s.fullRoundText})`); continue; }
    if (m.state !== 'settled') fails.push(`market for ${s.fullRoundText} not settled (${m.state})`);
    if (s.winnerId != null) {
      // Compare by name: the poller may match a pre-existing player (by name) whose
      // stored startgg_id differs, so re-deriving by id would give false mismatches.
      const we = s.winnerId === s.slots[0].entrant?.id ? s.slots[0].entrant : s.slots[1].entrant;
      const marketWinner = m.winner_id ? await db.getAsync('SELECT name FROM players WHERE id = ?', [m.winner_id]) : null;
      if (!we || !marketWinner || marketWinner.name !== we.name) fails.push(`winner mismatch on ${s.fullRoundText}: market "${marketWinner && marketWinner.name}" vs real "${we && we.name}"`);
    }
  }
  const resetMarket = markets.find((m) => isReset(m.round_text));
  const placedLeft = (await db.getAsync("SELECT COUNT(*) c FROM set_bets WHERE state='placed'")).c;
  if (placedLeft) fails.push(`${placedLeft} bets still unsettled`);

  const bankroll = await lm.houseBankrollCents();
  if (bankroll < 0) fails.push(`house bankroll negative: ${bankroll}`);
  if (minBankroll < 0) fails.push(`house bankroll dipped negative mid-run: ${minBankroll}`);

  let nowTotal = 0; for (const u of simUsers) nowTotal += await wallet.getBalance(u);
  const usersNet = nowTotal - startTotal;
  if (usersNet + bankroll !== 0) fails.push(`money not conserved: usersNet ${usersNet} + bankroll ${bankroll} != 0`);

  const wonRow = await db.getAsync("SELECT COUNT(*) c, COALESCE(SUM(payout_cents),0) p FROM set_bets WHERE state='won'");
  const lostRow = await db.getAsync("SELECT COUNT(*) c FROM set_bets WHERE state='lost'");

  console.log('--- timeline ---');
  console.log(`markets opened ${opened}, closed ${closed}, settled ${settled} across the walk`);
  console.log('\n--- betting ---');
  console.log(`sim users ${simUsers.length} | bets ${bets} | wagered ${usd(wagered)} | won ${wonRow.c} (paid ${usd(wonRow.p)}) | lost ${lostRow.c}`);
  console.log('\n--- economics ---');
  console.log(`house bankroll end ${usd(bankroll)} | min during run ${usd(minBankroll)} | users net ${usd(usersNet)}`);
  console.log('\n--- correctness ---');
  console.log(`markets: ${markets.length} | all settled: ${markets.every((m) => m.state === 'settled') ? 'yes' : 'NO'}`);
  console.log(`Grand Final Reset market: ${resetMarket ? `present + ${resetMarket.state}` : 'none in this event'}`);
  console.log(`winnerId->player mapping checked on ${realSets.length} sets`);

  if (fails.length) { console.log('\nRESULT: FAILURES'); fails.forEach((f) => console.log('  ✗ ' + f)); }
  else console.log('\nRESULT: all checks passed ✓ (markets open/close/settle, winners correct, reset handled, bankroll >= 0, money conserved)');

  console.log(`\n(replay DB left at db/database.replay.db — load it in the preview or delete it)`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
