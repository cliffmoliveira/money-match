// Pick'em engine (spec §4–§5): picks + lock, live/locked community split,
// idempotent settlement, coin ledger, leaderboards, streaks, seasons.
// Reuses set_markets (markets) and its inline player1/player2 ids as the two
// selections; a "pick" is the picked_player_id. No real-money path exists here.
const db = require('../db/db');
const { roundMultiplier, computePoints, computeCoins } = require('./scoring');
const { STREAK_MILESTONES } = require('./config');

function getMarket(marketId) {
  return db.getAsync('SELECT * FROM set_markets WHERE id = ?', [marketId]);
}

// Live community split — count-weighted (free mode has no stake). { total, split }
// where split = { player_id: share(0..1) }. Drives pre-lock "people's odds".
async function liveSplit(marketId) {
  const rows = await db.allAsync(
    'SELECT picked_player_id AS pid, COUNT(*) AS n FROM pickem_picks WHERE market_id = ? GROUP BY picked_player_id',
    [marketId]
  );
  const total = rows.reduce((s, r) => s + r.n, 0);
  const split = {};
  for (const r of rows) split[r.pid] = total > 0 ? r.n / total : 0;
  return { total, split };
}

// A market is locked for picks once its snapshot is taken, the underlying set is
// no longer open, or we're past locks_at.
function isLocked(market, now = Date.now()) {
  if (!market) return true;
  if (market.community_split != null) return true;
  if (market.state && market.state !== 'open') return true;
  if (market.locks_at) {
    const t = Date.parse(market.locks_at);
    if (!Number.isNaN(t) && now >= t) return true;
  }
  return false;
}

// Freeze the market: snapshot the live split + resolve round_multiplier. Idempotent.
// Picks are rejected after lock, so this snapshot stays the value scoring reads.
async function lockMarket(marketId) {
  const market = await getMarket(marketId);
  if (!market) throw new Error('market not found');
  if (market.community_split != null) return market; // already locked
  const { split } = await liveSplit(marketId);
  const rm = roundMultiplier(market.round);
  await db.runAsync(
    'UPDATE set_markets SET community_split = ?, round_multiplier = ? WHERE id = ?',
    [JSON.stringify(split), rm, marketId]
  );
  return getMarket(marketId);
}

// Create or edit a pick. One per (user, market); freely editable until lock; rejected after.
async function placePick({ userId, marketId, pickedPlayerId }, now = Date.now()) {
  const market = await getMarket(marketId);
  if (!market) throw new Error('market not found');
  if (pickedPlayerId !== market.player1_id && pickedPlayerId !== market.player2_id) {
    throw new Error('invalid selection: not a participant in this market');
  }
  if (isLocked(market, now)) {
    const e = new Error('market locked: picks are frozen');
    e.code = 'LOCKED';
    throw e;
  }
  const existing = await db.getAsync(
    'SELECT id FROM pickem_picks WHERE user_id = ? AND market_id = ?', [userId, marketId]
  );
  if (existing) {
    await db.runAsync('UPDATE pickem_picks SET picked_player_id = ? WHERE id = ?', [pickedPlayerId, existing.id]);
    return { id: existing.id, created: false };
  }
  const res = await db.runAsync(
    'INSERT INTO pickem_picks (user_id, market_id, picked_player_id, created_at) VALUES (?,?,?,?)',
    [userId, marketId, pickedPlayerId, new Date(now).toISOString()]
  );
  return { id: res.lastID, created: true };
}

// The active season at a given instant (ISO), or null.
function getActiveSeason(nowIso) {
  return db.getAsync(
    'SELECT * FROM seasons WHERE starts_at <= ? AND ends_at >= ? ORDER BY starts_at DESC LIMIT 1',
    [nowIso, nowIso]
  );
}

async function creditCoins(userId, delta, reason, refPickId, nowIso) {
  await db.runAsync(
    'INSERT INTO coin_ledger (user_id, delta, reason, ref_pick_id, created_at) VALUES (?,?,?,?,?)',
    [userId, delta, reason, refPickId ?? null, nowIso]
  );
  await db.runAsync('UPDATE users SET coin_balance = coin_balance + ? WHERE id = ?', [delta, userId]);
}

// Upsert one leaderboard scope row; returns the scope's new current_streak.
async function bumpLeaderboard(userId, scope, ref, points, correct, nowIso) {
  const row = await db.getAsync(
    'SELECT * FROM leaderboard_entries WHERE user_id = ? AND scope = ? AND scope_ref = ?', [userId, scope, ref]
  );
  if (!row) {
    const streak = correct ? 1 : 0;
    await db.runAsync(
      `INSERT INTO leaderboard_entries
         (user_id, scope, scope_ref, points, correct_count, total_picks, current_streak, best_streak, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [userId, scope, ref, points, correct ? 1 : 0, 1, streak, streak, nowIso]
    );
    return streak;
  }
  const newStreak = correct ? row.current_streak + 1 : 0;
  await db.runAsync(
    `UPDATE leaderboard_entries
       SET points = ?, correct_count = ?, total_picks = ?, current_streak = ?, best_streak = ?, updated_at = ?
     WHERE user_id = ? AND scope = ? AND scope_ref = ?`,
    [row.points + points, row.correct_count + (correct ? 1 : 0), row.total_picks + 1,
     newStreak, Math.max(row.best_streak, newStreak), nowIso, userId, scope, ref]
  );
  return newStreak;
}

// Idempotent settlement + scoring (spec §5). winnerPlayerId = the winning selection.
async function settleMarket(marketId, winnerPlayerId, nowIso = new Date().toISOString()) {
  const market = await getMarket(marketId);
  if (!market) throw new Error('market not found');
  if (market.pickem_scored_at) return { alreadyScored: true };

  // Ensure the lock snapshot + round multiplier exist (lazy lock is correct since
  // picks are frozen after lock).
  if (market.community_split == null) await lockMarket(marketId);
  const m = await getMarket(marketId);
  const split = JSON.parse(m.community_split || '{}');
  const season = await getActiveSeason(nowIso);

  const picks = await db.allAsync('SELECT * FROM pickem_picks WHERE market_id = ?', [marketId]);
  for (const pick of picks) {
    const correct = pick.picked_player_id === winnerPlayerId;
    let points = 0, coins = 0;
    if (correct) {
      const share = split[pick.picked_player_id] ?? 0;
      points = computePoints({ round: m.round, communityShare: share });
      coins = computeCoins(points);
    }
    await db.runAsync(
      'UPDATE pickem_picks SET result = ?, points_awarded = ?, coins_awarded = ?, scored_at = ? WHERE id = ?',
      [correct ? 'correct' : 'incorrect', points, coins, nowIso, pick.id]
    );
    if (coins > 0) await creditCoins(pick.user_id, coins, 'pick_reward', pick.id, nowIso);

    const scopes = [['global', ''], ['game', String(m.game_id)], ['event', String(m.tournament_id)]];
    if (season) scopes.push(['season', String(season.id)]);
    let globalStreak = 0;
    for (const [scope, ref] of scopes) {
      const s = await bumpLeaderboard(pick.user_id, scope, ref, points, correct, nowIso);
      if (scope === 'global') globalStreak = s;
    }
    if (correct) {
      const bonus = STREAK_MILESTONES[globalStreak];
      if (bonus) await creditCoins(pick.user_id, bonus, 'streak_bonus', null, nowIso);
    }
  }

  await db.runAsync('UPDATE set_markets SET winner_id = ?, pickem_scored_at = ? WHERE id = ?',
    [winnerPlayerId, nowIso, marketId]);
  return { scored: picks.length };
}

// Read helpers (UI + tests).
function getCoinBalance(userId) {
  return db.getAsync('SELECT coin_balance FROM users WHERE id = ?', [userId]).then((r) => (r ? r.coin_balance : 0));
}
function getLeaderboardEntry(userId, scope, ref = '') {
  return db.getAsync('SELECT * FROM leaderboard_entries WHERE user_id = ? AND scope = ? AND scope_ref = ?',
    [userId, scope, ref]);
}

module.exports = {
  getMarket, liveSplit, isLocked, lockMarket, placePick,
  getActiveSeason, settleMarket, getCoinBalance, getLeaderboardEntry,
};
