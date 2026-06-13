import React, { useEffect, useState } from 'react';
import './FutureTournaments.css';
import { getGameAlt, getGameLogoSources, getGameLogoStyle } from '../utils/gameLogos';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';

const FutureTournaments = () => {
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [betAmounts, setBetAmounts] = useState({}); // Tracks bet amounts for each player
  const [tournamentGames, setTournamentGames] = useState({});
  const [playerStats, setPlayerStats] = useState({}); // Tracks live odds and totals dynamically

  // Filters
  const [filterTournament, setFilterTournament] = useState('');
  const [filterGame, setFilterGame] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [filterYear, setFilterYear] = useState('');

  const userId = localStorage.getItem('userId');

  const GameTitle = ({ name, height = 28 }) => {
    const [error, setError] = useState(false);
    const [src, setSrc] = useState(null);
    const { avif, webp, png, jpg, jpeg } = getGameLogoSources(name || '');

    useEffect(() => {
      setError(false);
      const candidates = [avif, webp, png, jpg, jpeg].filter(Boolean);
      setSrc(candidates[0] || null);
    }, [avif, webp, png, jpg, jpeg]);

    if (process.env.NODE_ENV !== 'production') {
      console.log('[GameTitle] name=', name, { avif, webp, png, jpg, jpeg, chosen: src });
    }

    const handleError = () => {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[GameTitle] failed to load', src, 'for', name);
      }
      const candidates = [avif, webp, png, jpg, jpeg].filter(Boolean);
      const currentIndex = candidates.indexOf(src);
      if (currentIndex + 1 < candidates.length) {
        setSrc(candidates[currentIndex + 1]);
      } else {
        setError(true);
      }
    };

    if (!name) return null;

    if (error || !src) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', minHeight: `${height}px` }}>
          <h3 style={{ margin: 0 }}>{name}</h3>
        </div>
      );
    }

    return (
      <div style={{ display: 'flex', alignItems: 'center', minHeight: `${height}px` }}>
        {!error && src && (
          <img
            src={src}
            alt={getGameAlt(name)}
            style={getGameLogoStyle(name, height)}
            onError={handleError}
          />
        )}
        {error && (
          <span style={{ color: 'var(--brand)', fontWeight: 600 }}>{name}</span>
        )}
      </div>
    );
  };

  const TournamentLogo = ({ name, logoUrl, height = 24 }) => {
    const [index, setIndex] = useState(0);
    if (!name) return null;

    const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name);
    const candidates = [logoUrl, avif, webp, png, jpg, jpeg].filter(Boolean);
    const src = candidates[index];

    if (!src) {
      return <span className="tournament-text">{name}</span>;
    }

    return (
      <img
        src={src}
        alt={getTournamentAlt(name)}
        style={getTournamentLogoStyle(name, height)}
        title={name}
        onError={() => setIndex((i) => i + 1)}
      />
    );
  };

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
  
        // Client-side guard: filter past tournaments and sort by nearest date
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Normalize today to the start of the day
        const upcoming = (tournamentsData || [])
          .filter(t => {
            const d = new Date(t.date);
            return !isNaN(d) && d >= today;
          })
          .sort((a, b) => new Date(a.date) - new Date(b.date));
  
        // Map bets to unique keys using tournamentId, gameId, and playerId
        const formattedBetAmounts = {};
  
        betsData.forEach((bet) => {
          const key = `${bet.tournament_id}_${bet.game_id}_${bet.player_id}`;
          formattedBetAmounts[key] = bet.amount || '';
        });
  
        setTournaments(upcoming);
        setBetAmounts(formattedBetAmounts);
  
        // Fetch games for all tournaments
        const gameRequests = upcoming.map(async (tournament) => {
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
  
  const calculatePayout = (amount, live_odds) => {
    return (amount * live_odds).toFixed(2);
  };

  const handleBetChange = async (tournamentId, gameId, playerId) => {
    const key = `${tournamentId}_${gameId}_${playerId}`;
    const amount = betAmounts[key] || 0;

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

  // Build filter option sets
  const years = Array.from(new Set(
    tournaments.map(t => new Date(t.date).getFullYear()).filter(y => !isNaN(y))
  )).sort((a, b) => a - b);

  const countries = Array.from(new Set(
    tournaments.map(t => t.location?.country).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const allGames = Array.from(new Set(
    Object.values(tournamentGames).flat().map(g => g.game_name)
  )).sort((a, b) => a.localeCompare(b));

  const tournamentNames = Array.from(new Set(
    tournaments.map(t => t.name)
  )).sort((a, b) => a.localeCompare(b));

  // Apply filters
  const filteredTournaments = tournaments.filter(t => {
    const tournamentMatch = !filterTournament || t.name === filterTournament;
    const yearMatch = !filterYear || new Date(t.date).getFullYear().toString() === filterYear;
    const countryMatch = !filterCountry || (t.location?.country === filterCountry);
    const gameMatch = !filterGame || (tournamentGames[t.id]?.some(g => g.game_name === filterGame));
    return tournamentMatch && yearMatch && countryMatch && gameMatch;
  });

  const clearFilters = () => {
    setFilterTournament('');
    setFilterGame('');
    setFilterCountry('');
    setFilterYear('');
  };

  return (
    <div className="future-tournaments-container">
      {/* Title intentionally removed; navbar will highlight current page */}
      <div className="filter-section">
        <div className="filter-group">
          <label htmlFor="ft-tournament">Tournament</label>
          <select
            id="ft-tournament"
            className="filter-select"
            value={filterTournament}
            onChange={(e) => setFilterTournament(e.target.value)}
          >
            <option value="">All</option>
            {tournamentNames.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label htmlFor="ft-year">Year</label>
          <select
            id="ft-year"
            className="filter-select"
            value={filterYear}
            onChange={(e) => setFilterYear(e.target.value)}
          >
            <option value="">All</option>
            {years.map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label htmlFor="ft-country">Country</label>
          <select
            id="ft-country"
            className="filter-select"
            value={filterCountry}
            onChange={(e) => setFilterCountry(e.target.value)}
          >
            <option value="">All</option>
            {countries.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label htmlFor="ft-game">Game</label>
          <select
            id="ft-game"
            className="filter-select"
            value={filterGame}
            onChange={(e) => setFilterGame(e.target.value)}
          >
            <option value="">All</option>
            {allGames.map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </div>
        <button className="clear-filters" onClick={clearFilters}>Clear Filters</button>
        <div className="results-count">Showing {filteredTournaments.length} of {tournaments.length}</div>
      </div>
      {tournaments.length === 0 && (
        <p>No upcoming tournaments available right now.</p>
      )}
      {filteredTournaments.map((tournament) => (
        <div key={tournament.id} className="tournament">
          <div className="tournament-header">
            <h2>
              <TournamentLogo name={tournament.name} logoUrl={tournament.logoUrl} height={48} />
            </h2>
            <div className="tournament-details">
              <p>
                <strong>Date:</strong> {new Date(tournament.date).toLocaleDateString()}
              </p>
              <p>
                <strong>Location:</strong> {tournament.location.city}, {tournament.location.country}
              </p>
            </div>
          </div>
  
          {(() => {
            const gamesForTournament = tournamentGames[tournament.id] || [];
            const gamesToShow = filterGame
              ? gamesForTournament.filter(g => g.game_name === filterGame)
              : gamesForTournament;
            if (gamesToShow.length === 0) {
              return <p>No games available for this tournament.</p>;
            }
            return gamesToShow.map((game) => (
              <div key={game.game_id} className="game-section">
                <h3 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <GameTitle name={game.game_name} height={96} />
                </h3>
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
            ));
          })()}
        </div>
      ))}
    </div>
  );
  
};

export default FutureTournaments;
