import React, { useEffect, useState } from 'react';
import './Home.css';

const BetsList = () => {
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const userId = localStorage.getItem('userId'); // Retrieve userId from LocalStorage

  useEffect(() => {
    const fetchBets = async () => {
      try {
        if (!userId) {
          throw new Error('User ID not found in LocalStorage. Please log in again.');
        }

        console.log('UserId from LocalStorage:', userId); // Debug

        const response = await fetch(`/api/bets?userId=${userId}`);
        if (!response.ok) {
          throw new Error(`Failed to fetch bets: ${response.status}`);
        }
        const betsData = await response.json();
        console.log('Fetched Bets:', betsData);

        // Fetch additional details for tournaments, games, and players
        const [tournamentsResponse, gamesResponse, playersResponse] = await Promise.all([
          fetch('/api/tournaments'),
          fetch('/api/games'),
          fetch('/api/players'),
        ]);

        if (!tournamentsResponse.ok || !gamesResponse.ok || !playersResponse.ok) {
          throw new Error('Failed to fetch additional details.');
        }

        const tournaments = await tournamentsResponse.json();
        const games = await gamesResponse.json();
        const players = await playersResponse.json();

        console.log('Fetched Tournaments:', tournaments);
        console.log('Fetched Games:', games);
        console.log('Fetched Players:', players);

        if (!Array.isArray(tournaments) || !Array.isArray(games) || !Array.isArray(players)) {
          throw new Error('One of the additional API responses is not an array.');
        }

        // Map the bets with tournament, game, and player details
        const enrichedBets = betsData.map((bet) => ({
          ...bet,
          tournamentDate: tournaments.find((t) => t.id === bet.tournament_id)?.date || 'Unknown Date',
          tournamentName: tournaments.find((t) => t.id === bet.tournament_id)?.name || 'Unknown Tournament',
          tournamentCity: tournaments.find((t) => t.id === bet.tournament_id)?.location.city || 'Unknown Location',
          tournamentCountry: tournaments.find((t) => t.id === bet.tournament_id)?.location.country || 'Unknown Location',
          gameName: games.find((g) => g.id === bet.game_id)?.name || 'Unknown Game',
          playerName: players.find((p) => p.id === bet.player_id)?.name || 'Unknown Player',
        }));

        console.log('Enriched Bets:', enrichedBets);
        setBets(enrichedBets);
      } catch (err) {
        console.error('Error fetching bets:', err.message);
        setError('Failed to load your bets. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    fetchBets();
  }, [userId]);

  useEffect(() => {
    console.log('Bets State:', bets); // Debug State Changes
  }, [bets]);

  if (loading) {
    return <p>Loading your bets...</p>;
  }

  if (error) {
    return <p className="error-message">{error}</p>;
  }
  
  return (
    <div className="bets-list-container">
      <h1>Welcome to Money Match</h1>
      <p>Your upcoming bets:</p>
      {bets.length === 0 ? (
        <p>No bets found. Start placing bets to see them here!</p>
      ) : (
        <table className="bets-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Tournament Name</th>
              <th>Location</th>
              <th>Game Name</th>
              <th>Player Name</th>
              <th>Bet Amount</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {bets.map((bet, index) => (
              <tr key={index}>
                <td>{bet.tournamentDate || 'Unknown Date'}</td>
                <td>{bet.tournamentName || 'Unknown Tournament'}</td>
                <td>{bet.tournamentCity + ', ' + bet.tournamentCountry || 'Unknown Location'}</td>
                <td>{bet.gameName || 'Unknown Game'}</td>
                <td>{bet.playerName || 'Unknown Player'}</td>
                <td>
                  ${Number(bet.amount || 0).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </td>
                <td>
                  {bet.is_winner === 1 ? '✅ Win' : bet.is_winner === 0 ? '❌ Loss' : '🕒 Pending'}
                </td>              
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default BetsList;
