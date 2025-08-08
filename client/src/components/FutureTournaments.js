import React, { useEffect, useState } from 'react';
import './FutureTournaments.css';

const FutureTournaments = () => {
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [bets, setBets] = useState({}); // Tracks selected players for bets
  const [betAmounts, setBetAmounts] = useState({}); // Tracks bet amounts for each player
  const [tournamentGames, setTournamentGames] = useState({});
  const [playerStats, setPlayerStats] = useState({}); // Tracks live odds and totals dynamically

  const userId = localStorage.getItem('userId');

  useEffect(() => {
    const fetchTournamentsAndBets = async () => {
      try {
        const [tournamentsResponse, betsResponse] = await Promise.all([
          fetch('/api/tournaments'),
          fetch(`/api/bets?userId=${userId}`)
        ]);
  
        if (!tournamentsResponse.ok || !betsResponse.ok) {
          throw new Error('Failed to fetch tournaments or bets.');
        }
  
        const tournamentsData = await tournamentsResponse.json();
        const betsData = await betsResponse.json();
  
        // Map bets to unique keys using tournamentId, gameId, and playerId
        const formattedBets = {};
        const formattedBetAmounts = {};
  
        betsData.forEach((bet) => {
          const key = `${bet.tournament_id}_${bet.game_id}_${bet.player_id}`;
          formattedBets[key] = bet.player_id;
          formattedBetAmounts[key] = bet.amount || '';
        });
  
        setTournaments(tournamentsData);
        setBets(formattedBets);
        setBetAmounts(formattedBetAmounts);
  
        // Fetch games for all tournaments
        const gameRequests = tournamentsData.map(async (tournament) => {
          const response = await fetch(`/api/tournament/${tournament.id}/games`);
          if (response.ok) {
            const gamesData = await response.json();
            return { tournamentId: tournament.id, games: gamesData };
          }
          return { tournamentId: tournament.id, games: [] };
        });
  
        const gameResults = await Promise.all(gameRequests);
        const updatedTournamentGames = {};
        gameResults.forEach(({ tournamentId, games }) => {
          updatedTournamentGames[tournamentId] = games;
        });
        setTournamentGames(updatedTournamentGames);
  
        // Fetch players for all games
        const playerRequests = gameResults.flatMap(({ tournamentId, games }) => 
          games.map(async (game) => {
            const response = await fetch(`/api/game/${tournamentId}/${game.game_id}/players`);
            if (response.ok) {
              const playersData = await response.json();
              return { key: `${tournamentId}_${game.game_id}`, players: playersData };
            }
            return { key: `${tournamentId}_${game.game_id}`, players: [] };
          })
        );
  
        const playerResults = await Promise.all(playerRequests);
        const updatedPlayerStats = {};
        playerResults.forEach(({ key, players }) => {
          updatedPlayerStats[key] = players;
        });
        setPlayerStats(updatedPlayerStats);
  
      } catch (err) {
        console.error('Error fetching tournaments, games, or players:', err.message);
        setError('Failed to load future tournaments, games, or players.');
      } finally {
        setLoading(false);
      }
    };
  
    fetchTournamentsAndBets();
  }, [userId]);
  

  // 📍 **Debugging State Changes**
useEffect(() => {
  console.log('Tournaments:', tournaments);
  console.log('Tournament Games:', tournamentGames);
  console.log('Player Stats:', playerStats);
}, [tournaments, tournamentGames, playerStats]);

  

  const calculatePayout = (amount, live_odds) => {
    return (amount * live_odds).toFixed(2);
  };

  const handleBetChange = async (tournamentId, gameId, playerId) => {
    const key = `${tournamentId}_${gameId}_${playerId}`;
    const amount = betAmounts[key] || 0;

    console.log('Sending Bet Payload:', {
      userId,
      tournamentId,
      gameId,
      playerId,
      amount,
    });

    try {
      const response = await fetch('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          tournamentId,
          gameId,
          playerId,
          amount,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Failed to save bet: ${errorData.error || response.statusText}`);
      }

      console.log('Bet saved successfully');

      // Fetch updated live odds
      const updatedStatsResponse = await fetch(`/api/game/${tournamentId}/${gameId}/players`);
      if (updatedStatsResponse.ok) {
        const updatedStats = await updatedStatsResponse.json();
        setPlayerStats((prev) => ({
          ...prev,
          [`${tournamentId}_${gameId}`]: updatedStats,
        }));
      }
    } catch (err) {
      console.error('Error saving bet:', err.message);
      alert('Failed to save your bet. Please try again.');
    }
  };

  const handleBetAmountChange = (tournamentId, gameId, playerId, amount) => {
    const key = `${tournamentId}_${gameId}_${playerId}`;
    setBetAmounts((prev) => ({
      ...prev,
      [key]: amount.replace(/[^0-9.]/g, ''),
    }));
  };

  if (loading) return <p>Loading future tournaments...</p>;
  if (error) return <p className="error-message">{error}</p>;

  return (
    <div className="future-tournaments-container">
      <h1>Upcoming Tournaments</h1>
      {tournaments.map((tournament) => (
        <div key={tournament.id} className="tournament">
          <h2>{tournament.name}</h2>
          <p>
            <strong>Date:</strong> {new Date(tournament.date).toLocaleDateString()}
          </p>
          <p>
            <strong>Location:</strong> {tournament.location.city}, {tournament.location.country}
          </p>
  
          {tournamentGames[tournament.id]?.length > 0 ? (
            tournamentGames[tournament.id].map((game) => (
              <div key={game.game_id} className="game-section">
                <h3>{game.game_name}</h3>
                <table className="tournament-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Live Odds</th>
                      <th>Total Bets</th>
                      <th>Total Amount</th>
                      <th>Your Bet</th>
                      <th>Payout</th>
                    </tr>
                  </thead>
                  <tbody>
                    {playerStats[`${tournament.id}_${game.game_id}`]?.map((player) => {
                      const key = `${tournament.id}_${game.game_id}_${player.player_id}`;
                      const betAmount = betAmounts[key] || '';
  
                      return (
                        <tr key={player.player_id}>
                          <td>{player.player_name}</td>
                          <td>{player.live_odds?.toFixed(2)}</td>
                          <td>{player.total_bets || 0}</td>
                          <td>${player.total_amount || 0}</td>
                          <td>
                            <input
                              type="number"
                              value={betAmount}
                              onChange={(e) =>
                                handleBetAmountChange(
                                  tournament.id,
                                  game.game_id,
                                  player.player_id,
                                  e.target.value
                                )
                              }
                              onBlur={() =>
                                handleBetChange(
                                  tournament.id,
                                  game.game_id,
                                  player.player_id
                                )
                              }
                            />
                          </td>
                          <td>${calculatePayout(betAmount || 0, player.live_odds)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))
          ) : (
            <p>No games available for this tournament.</p>
          )}
        </div>
      ))}
    </div>
  );
  
};

export default FutureTournaments;
