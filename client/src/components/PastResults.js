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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(30); // incremental render; "Show more" reveals the rest

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

  // Reset the incremental window when filters change so a new result set starts at the top.
  useEffect(() => { setVisibleCount(30); }, [filterYear, filterTournament, filterGame]);

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
  const shown = filteredResults.slice(0, visibleCount);

  const clearFilters = () => {
    setFilterYear('all');
    setFilterTournament('all');
    setFilterGame('all');
  };

  // Active filters drive the toggle's count badge + the removable chips.
  const activeFilters = [
    filterYear !== 'all' && { key: 'year', label: filterYear, clear: () => setFilterYear('all') },
    filterTournament !== 'all' && { key: 'tournament', label: filterTournament, clear: () => setFilterTournament('all') },
    filterGame !== 'all' && { key: 'game', label: filterGame, clear: () => setFilterGame('all') },
  ].filter(Boolean);

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
      <h1 className="sr-only">Results</h1>

      {/* Filters */}
      <div className="filter-bar">
        <button
          type="button"
          className={`filter-toggle${activeFilters.length ? ' has-active' : ''}`}
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
        >
          <svg className="filter-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
          </svg>
          Filters
          {activeFilters.length > 0 && <span className="filter-count">{activeFilters.length}</span>}
          <span className={`filter-toggle-chevron${filtersOpen ? ' open' : ''}`} aria-hidden="true">▾</span>
        </button>

        {activeFilters.map((f) => (
          <button key={f.key} type="button" className="filter-chip" onClick={f.clear} title={`Remove ${f.label}`}>
            {f.label}<span className="chip-x" aria-hidden="true">×</span>
          </button>
        ))}

        <span className="results-count">
          Showing {filteredResults.length} of {pastResults.length} results
        </span>
      </div>

      {filtersOpen && (
        <div className="filter-panel">
          <div className="filter-group">
            <label htmlFor="yearFilter">Year</label>
            <select id="yearFilter" className="filter-select" value={filterYear} onChange={(e) => setFilterYear(e.target.value)}>
              <option value="all">All Years</option>
              {years.map((year) => (<option key={year} value={year}>{year}</option>))}
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="tournamentFilter">Tournament</label>
            <select id="tournamentFilter" className="filter-select" value={filterTournament} onChange={(e) => setFilterTournament(e.target.value)}>
              <option value="all">All Tournaments</option>
              {tournaments.map((name) => (<option key={name} value={name}>{name}</option>))}
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="gameFilter">Game</label>
            <select id="gameFilter" className="filter-select" value={filterGame} onChange={(e) => setFilterGame(e.target.value)}>
              <option value="all">All Games</option>
              {games.map((name) => (<option key={name} value={name}>{name}</option>))}
            </select>
          </div>
          {activeFilters.length > 0 && (
            <button className="clear-filters" onClick={clearFilters}>Clear</button>
          )}
        </div>
      )}

      {filteredResults.length === 0 ? (
        <div className="no-results">
          <p>No past results match the selected filters.</p>
        </div>
      ) : (
        <>
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
              {shown.map((result) => (
                <tr key={result.id} className="result-row">
                  <td className="tournament-name">
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                      <TournamentNameOrLogo name={result.tournament} logoUrl={result.logoUrl} height={64} />
                      <span style={{ textAlign: 'center' }}>{result.tournament}</span>
                    </div>
                  </td>
                  <td className="location" data-label="Location">
                    {result.city && result.country
                      ? `${result.city}, ${result.country}`
                      : 'Unknown Location'
                    }
                  </td>
                  <td className="date" data-label="Date">
                    {new Date(result.date + 'T00:00:00').toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric'
                    })}
                  </td>
                  <td className="game" data-label="Game">
                    <GameTitle name={result.game} height={56} />
                  </td>
                  <td className="winner" data-label="Winner">{result.winner}</td>
                  <td className="score" data-label="Score">
                    {result.winnerRoundsWon} - {result.loserRoundsWon}
                  </td>
                  <td className="loser" data-label="Loser">{result.loser}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="results-cards">
          {shown.map((result) => (
            <div className="result-card" key={result.id}>
              <TournamentNameOrLogo name={result.tournament} logoUrl={result.logoUrl} height={30} />
              <div className="rc-body">
                <div className="rc-result">
                  <span className="rc-winner">{result.winner}</span>
                  <span className="rc-score">{result.winnerRoundsWon}–{result.loserRoundsWon}</span>
                  <span className="rc-loser">{result.loser}</span>
                </div>
                <div className="rc-meta">
                  {result.game} · {new Date(result.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · {result.tournament}
                </div>
              </div>
            </div>
          ))}
        </div>

        {filteredResults.length > visibleCount && (
          <button type="button" className="load-more" onClick={() => setVisibleCount((c) => c + 30)}>
            Show more ({filteredResults.length - visibleCount} more)
          </button>
        )}
        </>
      )}
    </div>
  );
};

export default PastResults;
