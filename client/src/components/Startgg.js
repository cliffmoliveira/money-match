import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './Startgg.css';

const API_URL = 'https://api.start.gg/gql/alpha';
const STARTGG_TOKEN = 'c69e996435016150623130ab805d440e'; // Hardcoded token

const StartGGTournaments = () => {
  const [tournaments, setTournaments] = useState([]);
  const [selectedTournament, setSelectedTournament] = useState(null);
  const [games, setGames] = useState([]);
  const [selectedGame, setSelectedGame] = useState(null);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchTournaments = async () => {
      setLoading(true);
      try {
        const query = `
          query Tournaments($perPage: Int!) {
            tournaments(query: { perPage: $perPage }) {
              nodes {
                id
                name
                slug
                startAt
                endAt
              }
            }
          }
        `;

        const response = await axios.post(
          API_URL,
          { query, variables: { perPage: 100 } },
          {
            headers: {
              Authorization: `Bearer ${STARTGG_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );

        const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
        const oneYearLater = currentTime + 365 * 24 * 60 * 60; // One year from now in seconds

        const upcomingTournaments = response.data.data.tournaments.nodes.filter(
          (tournament) => tournament.startAt >= currentTime && tournament.startAt <= oneYearLater
        );

        const sortedTournaments = upcomingTournaments.sort((a, b) => a.startAt - b.startAt);
        setTournaments(sortedTournaments || []);
      } catch (err) {
        console.error('Error fetching tournaments:', err.response?.data || err.message);
        setError('Failed to fetch tournaments.');
      } finally {
        setLoading(false);
      }
    };

    fetchTournaments();
  }, []);

  const fetchGames = async (tournamentSlug) => {
    setLoading(true);
    try {
      const query = `
        query Games($slug: String!) {
          tournament(slug: $slug) {
            events {
              id
              name
            }
          }
        }
      `;

      const response = await axios.post(
        API_URL,
        { query, variables: { slug: tournamentSlug } },
        {
          headers: {
            Authorization: `Bearer ${STARTGG_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );

      setGames(response.data.data.tournament.events || []);
      setSelectedTournament(tournamentSlug);
    } catch (err) {
      console.error('Error fetching games:', err.response?.data || err.message);
      setError('Failed to fetch games.');
    } finally {
        setLoading(false);
    }
  };

  const fetchPlayers = async (eventId) => {
    setLoading(true);
    try {
      const query = `
        query Players($eventId: ID!) {
          event(id: $eventId) {
            entrants(query: { perPage: 100 }) {
              nodes {
                id
                name
              }
            }
          }
        }
      `;

      const response = await axios.post(
        API_URL,
        { query, variables: { eventId } },
        {
          headers: {
            Authorization: `Bearer ${STARTGG_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );

      setPlayers(response.data.data.event.entrants.nodes || []);
      setSelectedGame(eventId);
    } catch (err) {
      console.error('Error fetching players:', err.response?.data || err.message);
      setError('Failed to fetch players.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Start.gg Fighting Game Tournaments</h1>

      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}

      {!selectedTournament && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Start Date</th>
              <th>End Date</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {tournaments.map((tournament) => {
              const startDate = new Date(tournament.startAt * 1000).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              });

              const endDate = tournament.endAt
                ? new Date(tournament.endAt * 1000).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })
                : 'TBD';

              return (
                <tr key={tournament.id}>
                  <td>{tournament.name}</td>
                  <td>{startDate}</td>
                  <td>{endDate}</td>
                  <td>
                    <button onClick={() => fetchGames(tournament.slug)}>View Games</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selectedTournament && !selectedGame && (
        <div>
          <h2>Games in {selectedTournament}</h2>
          <button onClick={() => setSelectedTournament(null)}>Back to Tournaments</button>
          <table>
            <thead>
              <tr>
                <th>Game Name</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {games.map((game) => (
                <tr key={game.id}>
                  <td>{game.name}</td>
                  <td>
                    <button onClick={() => fetchPlayers(game.id)}>View Players</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedGame && (
        <div>
          <h2>Players in Game {selectedGame}</h2>
          <button onClick={() => setSelectedGame(null)}>Back to Games</button>
          <table>
            <thead>
              <tr>
                <th>Player Name</th>
              </tr>
            </thead>
            <tbody>
              {players.map((player) => (
                <tr key={player.id}>
                  <td>{player.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default StartGGTournaments;
