import React, { useEffect, useState } from 'react';
import './PastResults.css';
import { getGameAlt, getGameLogoSources, getGameLogoStyle } from '../utils/gameLogos';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';

const PastResults = () => {
  const [pastResults, setPastResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterYear, setFilterYear] = useState('all');
  const [filterTournament, setFilterTournament] = useState('all');
  const [filterGame, setFilterGame] = useState('all');

  const GameTitle = ({ name, height = 22 }) => {
    const [error, setError] = useState(false);
    const [src, setSrc] = useState(null);
    const { svg, avif, webp, png, jpg, jpeg } = getGameLogoSources(name || '');

    useEffect(() => {
      setError(false);
      const candidates = [svg, avif, webp, png, jpg, jpeg].filter(Boolean);
      setSrc(candidates[0] || null);
    }, [svg, avif, webp, png, jpg, jpeg]);

    if (process.env.NODE_ENV !== 'production') {
      console.log('[GameTitle] name=', name, { svg, avif, webp, png, jpg, jpeg, chosen: src });
    }

    const handleError = () => {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[GameTitle] failed to load', src, 'for', name);
      }
      const candidates = [svg, avif, webp, png, jpg, jpeg].filter(Boolean);
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
          <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{name}</span>
        </div>
      );
    }

    return (
      <div style={{ display: 'flex', alignItems: 'center', minHeight: `${height}px` }}>
        <img
          src={src}
          alt={getGameAlt(name)}
          style={getGameLogoStyle(name, height)}
          onError={handleError}
        />
      </div>
    );
  };

  // Tries the start.gg logo URL first, then local assets; falls back to plain
  // text once every candidate has failed (no broken-image icon).
  const TournamentNameOrLogo = ({ name, logoUrl, height = 24 }) => {
    const [index, setIndex] = useState(0);
    if (!name) return null;
    const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name);
    const candidates = [logoUrl, avif, webp, png, jpg, jpeg].filter(Boolean);
    const src = candidates[index];
    if (!src) return null;
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
    const fetchPastResults = async () => {
      try {
        const response = await fetch('/api/past-results');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Sort the data by descending date
        const sortedData = data.data.sort((a, b) => new Date(b.date) - new Date(a.date));

        setPastResults(sortedData);
      } catch (err) {
        console.error('Error fetching past results:', err);
        setError('Failed to load past results. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    fetchPastResults();
  }, []);

  // Filter option lists
  const years = [...new Set(pastResults.map(r => new Date(r.date).getFullYear().toString()))].sort((a, b) => b - a);
  const tournaments = [...new Set(pastResults.map(r => r.tournament))].sort((a, b) => a.localeCompare(b));
  const games = [...new Set(pastResults.map(r => r.game))].sort((a, b) => a.localeCompare(b));

  // Apply filters (AND)
  const filteredResults = pastResults.filter(result => {
    const yearOk = filterYear === 'all' || new Date(result.date).getFullYear().toString() === filterYear;
    const tournamentOk = filterTournament === 'all' || result.tournament === filterTournament;
    const gameOk = filterGame === 'all' || result.game === filterGame;
    return yearOk && tournamentOk && gameOk;
  });

  const clearFilters = () => {
    setFilterYear('all');
    setFilterTournament('all');
    setFilterGame('all');
  };

  if (loading) {
    return (
      <div className="past-results-container">
        <div className="loading-spinner">Loading past results...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="past-results-container">
        <div className="error-message">{error}</div>
      </div>
    );
  }

  return (
    <div className="past-results-container">
      <h1>Results</h1>
      <p className="results-subtitle">Every settled major — champions in gold, with the deciding score.</p>

      {/* Filters */}
      <div className="filter-section">
        <div className="filter-group">
          <label htmlFor="yearFilter">Year</label>
          <select
            id="yearFilter"
            value={filterYear}
            onChange={(e) => setFilterYear(e.target.value)}
            className="filter-select"
          >
            <option value="all">All Years</option>
            {years.map((year) => (<option key={year} value={year}>{year}</option>))}
          </select>
        </div>

        <div className="filter-group">
          <label htmlFor="tournamentFilter">Tournament</label>
          <select
            id="tournamentFilter"
            value={filterTournament}
            onChange={(e) => setFilterTournament(e.target.value)}
            className="filter-select"
          >
            <option value="all">All Tournaments</option>
            {tournaments.map((name) => (<option key={name} value={name}>{name}</option>))}
          </select>
        </div>

        <div className="filter-group">
          <label htmlFor="gameFilter">Game</label>
          <select
            id="gameFilter"
            value={filterGame}
            onChange={(e) => setFilterGame(e.target.value)}
            className="filter-select"
          >
            <option value="all">All Games</option>
            {games.map((name) => (<option key={name} value={name}>{name}</option>))}
          </select>
        </div>

        <button className="clear-filters" onClick={clearFilters}>Clear Filters</button>

        <span className="results-count">
          Showing {filteredResults.length} of {pastResults.length} results
        </span>
      </div>

      {filteredResults.length === 0 ? (
        <div className="no-results">
          <p>No past results match the selected filters.</p>
        </div>
      ) : (
        <div className="results-table-container">
          <table className="results-table">
            <thead>
              <tr>
                <th>Tournament</th>
                <th>Location</th>
                <th>Date</th>
                <th className="game">Game</th>
                <th>Winner</th>
                <th>Score</th>
                <th>Loser</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.map((result) => (
                <tr key={result.id} className="result-row">
                  <td className="tournament-name">
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                      <TournamentNameOrLogo name={result.tournament} logoUrl={result.logoUrl} height={64} />
                      <span style={{ textAlign: 'center' }}>{result.tournament}</span>
                    </div>
                  </td>
                  <td className="location">
                    {result.city && result.country
                      ? `${result.city}, ${result.country}`
                      : 'Unknown Location'
                    }
                  </td>
                  <td className="date">
                    {new Date(result.date + 'T00:00:00').toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric'
                    })}
                  </td>
                  <td className="game">
                    <GameTitle name={result.game} height={56} />
                  </td>
                  <td className="winner">{result.winner}</td>
                  <td className="score">
                    {result.winnerRoundsWon} - {result.loserRoundsWon}
                  </td>
                  <td className="loser">{result.loser}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="summary-stats">
        <h3>Summary Statistics</h3>
        <div className="stats-grid">
          <div className="stat-item">
            <span className="stat-label">Total Matches:</span>
            <span className="stat-value">{pastResults.length}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Tournaments:</span>
            <span className="stat-value">
              {new Set(pastResults.map(r => r.tournament)).size}
            </span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Games:</span>
            <span className="stat-value">
              {new Set(pastResults.map(r => r.game)).size}
            </span>
          </div>
          <div className="stat-item">
            <span className="stat-label">Competitors:</span>
            <span className="stat-value">
              {new Set([
                ...pastResults.map(r => r.winner),
                ...pastResults.map(r => r.loser)
              ]).size}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PastResults;
