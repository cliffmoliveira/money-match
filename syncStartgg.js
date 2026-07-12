const db = require('./db/db');
const { startgg } = require('./startggClient');
const { findOrCreatePlayerId } = require('./scripts/lib/players');

const GQL_TOURNAMENT_GF = `
query TournamentGF($slug: String!) {
  tournament(slug: $slug) {
    id name city addrState countryCode startAt
    events {
      id name
      videogame { id name }
      sets(perPage: 100, page: 1, sortType: STANDARD, filters: {state: 3}) {
        nodes { id fullRoundText completedAt winnerId
          slots { entrant { id name participants { images { type url } player { id } } } standing { stats { score { value } } } }
        }
      }
    }
  }
}`;

const GQL_TOURNAMENTS = `
query TournamentsRange($page: Int!, $perPage: Int!, $after: Timestamp, $before: Timestamp) {
  tournaments(query: { page: $page, perPage: $perPage, filter: { afterDate: $after, beforeDate: $before } }) {
    pageInfo { total totalPages page perPage }
    nodes { id name slug startAt }
  }
}`;

function isGrandFinal(fullRoundText = '') {
  const t = fullRoundText?.toLowerCase?.() || '';
  return t.includes('grand final');
}

async function upsertTournament(t) {
  // Full timestamp, not just the calendar date — start.gg's startAt already
  // carries the real start hour; date('unixepoch', ?) used to throw it away.
  const date = new Date(t.startAt * 1000).toISOString();
  await db.runAsync(
    `INSERT INTO tournaments (name, date, city, country, startgg_id)
     SELECT ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM tournaments WHERE startgg_id = ?);
     UPDATE tournaments SET name=?, date=?, city=?, country=?
     WHERE startgg_id=?;`,
    [t.name, date, t.city || '', t.countryCode || '', t.id, t.id,
     t.name, date, t.city || '', t.countryCode || '', t.id]
  );
  const row = await db.getAsync(`SELECT id FROM tournaments WHERE startgg_id = ?`, [t.id]);
  return row?.id;
}

async function upsertGame(g) {
  await db.runAsync(
    `INSERT INTO games (name, startgg_id)
     SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM games WHERE startgg_id = ?);
     UPDATE games SET name=? WHERE startgg_id=?;`,
    [g.name, g.id, g.id, g.name, g.id]
  );
  const row = await db.getAsync(`SELECT id FROM games WHERE startgg_id = ?`, [g.id]);
  return row?.id;
}

// findOrCreatePlayerId lives in ./scripts/lib/players — shared with every
// other ingestion script (see that module's doc comment for why: Entrant.id
// isn't a stable per-person identifier, Participant.player.id is).

async function upsertMatch(set, tournamentId, gameId) {
  const p0 = set.slots?.[0]?.entrant || { name: 'Unknown' };
  const p1 = set.slots?.[1]?.entrant || { name: 'Unknown' };
  const s0 = set.slots?.[0]?.standing?.stats?.score?.value ?? 0;
  const s1 = set.slots?.[1]?.standing?.stats?.score?.value ?? 0;
  const p0Id = await findOrCreatePlayerId(p0);
  const p1Id = await findOrCreatePlayerId(p1);

  const winnerIsP0 = set.winnerId === p0.id;
  const winnerId = winnerIsP0 ? p0Id : p1Id;
  const loserId = winnerIsP0 ? p1Id : p0Id;
  const player1RoundsWon = s0;
  const player2RoundsWon = s1;

  await db.runAsync(
    `INSERT INTO matches (tournament_id, game_id, player1_id, player2_id, winner_id, loser_id, player1RoundsWon, player2RoundsWon, startgg_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM matches WHERE startgg_id = ?);
     UPDATE matches SET tournament_id=?, game_id=?, player1_id=?, player2_id=?, winner_id=?, loser_id=?, player1RoundsWon=?, player2RoundsWon=?
     WHERE startgg_id = ?;`,
    [tournamentId, gameId, p0Id, p1Id, winnerId, loserId, player1RoundsWon, player2RoundsWon, set.id, set.id,
     tournamentId, gameId, p0Id, p1Id, winnerId, loserId, player1RoundsWon, player2RoundsWon, set.id]
  );
}

async function syncTournamentBySlug(slug, token) {
  const data = await startgg(GQL_TOURNAMENT_GF, { slug }, token);
  const t = data?.tournament;
  if (!t) return { ok: false, reason: 'not_found' };

  const tournamentId = await upsertTournament(t);

  let inserted = 0;
  for (const ev of t.events || []) {
    const gameId = await upsertGame(ev.videogame);
    const gfSets = (ev.sets?.nodes || []).filter(s => isGrandFinal(s.fullRoundText));
    if (gfSets.length === 0) continue;

    const latest = gfSets.sort((a,b) => (b.completedAt || 0) - (a.completedAt || 0))[0];
    await upsertMatch(latest, tournamentId, gameId);
    inserted += 1;
  }
  return { ok: true, tournamentId, inserted };
}

async function syncRecent({ after, before, perPage = 20, maxPages = 10 }, token) {
  let page = 1;
  let totalInserted = 0;
  let slugsSynced = 0;
  while (page <= maxPages) {
    const data = await startgg(GQL_TOURNAMENTS, { page, perPage, after, before }, token);
    const list = data?.tournaments;
    const nodes = list?.nodes || [];
    if (nodes.length === 0) break;

    for (const t of nodes) {
      if (!t.slug) continue;
      const res = await syncTournamentBySlug(t.slug, token);
      if (res?.ok) {
        totalInserted += res.inserted || 0;
        slugsSynced += 1;
      }
    }

    if (page >= (list?.pageInfo?.totalPages || page)) break;
    page += 1;
  }
  return { ok: true, slugsSynced, totalInserted };
}

module.exports = { syncTournamentBySlug, syncRecent };
