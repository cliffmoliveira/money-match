const axios = require('axios');
const cheerio = require('cheerio');
const db = require('../db/db');

const EVO_URL = 'https://www.eventhubs.com/news/2025/jul/31/evo-2025-results/';

// Map EventHubs game headers to our DB game names
const MAIN_GAMES = {
  'Street Fighter 6': 'Street Fighter 6',
  'Tekken 8': 'Tekken 8',
  'Fatal Fury: City of the Wolves': 'Fatal Fury: City of the Wolves',
  'Guilty Gear Strive': 'Guilty Gear Strive',
  'Granblue Fantasy Versus Rising': 'Granblue Fantasy: Versus',
  'Marvel vs. Capcom 2': 'Marvel vs. Capcom 2',
  'Under Night In-Birth 2 [Sys:celes]': 'Under Night In-Birth Exe:Late[cl-r]',
  'Mortal Kombat 1': 'Mortal Kombat 1',
};

async function ensureTournamentEvo2025() {
  const row = await db.getAsync("SELECT id FROM tournaments WHERE name = 'EVO 2025'");
  if (row?.id) return row.id;
  await db.runAsync(
    `INSERT INTO tournaments (name, date, city, country) VALUES (?, ?, ?, ?)`,
    ['EVO 2025', '2025-08-01', 'Las Vegas', 'United States']
  );
  const r2 = await db.getAsync("SELECT id FROM tournaments WHERE name = 'EVO 2025'");
  return r2.id;
}

async function ensureGame(name) {
  const row = await db.getAsync(`SELECT id FROM games WHERE name = ?`, [name]);
  if (row?.id) return row.id;
  await db.runAsync(`INSERT INTO games (name) VALUES (?)`, [name]);
  const r2 = await db.getAsync(`SELECT id FROM games WHERE name = ?`, [name]);
  return r2.id;
}

async function ensurePlayer(name) {
  const row = await db.getAsync(`SELECT id FROM players WHERE name = ?`, [name]);
  if (row?.id) return row.id;
  await db.runAsync(`INSERT INTO players (name, country) VALUES (?, '')`, [name]);
  const r2 = await db.getAsync(`SELECT id FROM players WHERE name = ?`, [name]);
  return r2.id;
}

async function upsertMatch(tournamentId, gameId, winnerName, loserName, winnerScore = 3, loserScore = 2) {
  const winnerId = await ensurePlayer(winnerName);
  const loserId = await ensurePlayer(loserName);
  // Use a deterministic key: tournament+game+winner+loser
  const existing = await db.getAsync(
    `SELECT id FROM matches WHERE tournament_id = ? AND game_id = ? AND winner_id = ? AND loser_id = ?`,
    [tournamentId, gameId, winnerId, loserId]
  );
  if (!existing) {
    await db.runAsync(
      `INSERT INTO matches (tournament_id, game_id, player1_id, player2_id, winner_id, loser_id, player1RoundsWon, player2RoundsWon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tournamentId, gameId, winnerId, loserId, winnerId, loserId, winnerScore, loserScore]
    );
  } else {
    await db.runAsync(
      `UPDATE matches SET player1_id=?, player2_id=?, winner_id=?, loser_id=?, player1RoundsWon=?, player2RoundsWon=? WHERE id = ?`,
      [winnerId, loserId, winnerId, loserId, winnerScore, loserScore, existing.id]
    );
  }
}

function extractTop2($, headerEl) {
  // For each game header, the following list contains placements. We find lines starting with '1.' and '2.'
  const gameSection = $(headerEl).nextUntil('h1,h2,h3,h4');
  const lines = gameSection.text().split('\n').map(s => s.trim()).filter(Boolean);
  let first = null, second = null;
  for (const line of lines) {
    if (!first && /^1\./.test(line)) first = line;
    if (!second && /^2\./.test(line)) second = line;
    if (first && second) break;
  }
  const clean = s => (s || '').replace(/^\d+\.?\s*/, '').split('(')[0].trim();
  return { first: clean(first), second: clean(second) };
}

async function run() {
  const { data: html } = await axios.get(EVO_URL);
  const $ = cheerio.load(html);
  const tournamentId = await ensureTournamentEvo2025();

  // For each game header matching MAIN_GAMES, get top2
  for (const [ehName, dbName] of Object.entries(MAIN_GAMES)) {
    // Find header with exact game name followed by '— Results' or similar pattern
    const header = $(`h1,h2,h3,h4`).filter((i, el) => $(el).text().trim().startsWith(ehName));
    if (header.length === 0) continue;
    const { first, second } = extractTop2($, header[0]);
    if (!first || !second) continue;

    const gameId = await ensureGame(dbName);
    await upsertMatch(tournamentId, gameId, first, second, 3, 2);
    console.log(`Imported ${dbName}: ${first} over ${second}`);
  }
  console.log('Done.');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
