import React, { useState } from 'react';
import './TournamentFilterBar.css';

/**
 * TournamentFilterBar — a purely presentational Year / Tournament / Game
 * filter bar. It owns NO data: the parent supplies the option lists, the
 * current selection (`value`), the results count, and the change/clear
 * handlers. The only internal state is whether the filter panel is open.
 *
 * props:
 *   years        : string[]   option values for the Year dropdown (parent-sorted)
 *   tournaments  : string[]   option values for the Tournament dropdown
 *   games        : string[]   option values for the Game dropdown
 *   value        : { year, tournament, game }   'all' means no filter
 *   onChange     : (next) => void   called with the FULL next value object
 *   onClear      : () => void       reset all to { year:'all', tournament:'all', game:'all' }
 *   resultsCount : number           shown as "N results"
 */
const TournamentFilterBar = ({
  years = [],
  tournaments = [],
  games = [],
  value = { year: 'all', tournament: 'all', game: 'all' },
  onChange,
  onClear,
  resultsCount = 0,
}) => {
  const [open, setOpen] = useState(false);

  // Active selections drive the toggle's count badge and the removable chips.
  const activeFilters = [
    value.year !== 'all' && { key: 'year', label: value.year },
    value.tournament !== 'all' && { key: 'tournament', label: value.tournament },
    value.game !== 'all' && { key: 'game', label: value.game },
  ].filter(Boolean);

  const setField = (field, next) => onChange && onChange({ ...value, [field]: next });

  return (
    <div className="tournament-filter-bar">
      <div className="filter-bar">
        <button
          type="button"
          className={`filter-toggle${activeFilters.length ? ' has-active' : ''}`}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <svg className="filter-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
          </svg>
          Filters
          {activeFilters.length > 0 && <span className="filter-count">{activeFilters.length}</span>}
          <span className={`filter-toggle-chevron${open ? ' open' : ''}`} aria-hidden="true">▾</span>
        </button>

        {activeFilters.map((f) => (
          <button
            key={f.key}
            type="button"
            className="filter-chip"
            onClick={() => setField(f.key, 'all')}
            title={`Remove ${f.label}`}
          >
            {f.label}<span className="chip-x" aria-hidden="true">×</span>
          </button>
        ))}

        <span className="results-count">{resultsCount} results</span>
      </div>

      {open && (
        <div className="filter-panel">
          <div className="filter-group">
            <label htmlFor="tfb-yearFilter">Year</label>
            <select
              id="tfb-yearFilter"
              className="filter-select"
              value={value.year}
              onChange={(e) => setField('year', e.target.value)}
            >
              <option value="all">All years</option>
              {years.map((year) => (<option key={year} value={year}>{year}</option>))}
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="tfb-tournamentFilter">Tournament</label>
            <select
              id="tfb-tournamentFilter"
              className="filter-select"
              value={value.tournament}
              onChange={(e) => setField('tournament', e.target.value)}
            >
              <option value="all">All tournaments</option>
              {tournaments.map((name) => (<option key={name} value={name}>{name}</option>))}
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="tfb-gameFilter">Game</label>
            <select
              id="tfb-gameFilter"
              className="filter-select"
              value={value.game}
              onChange={(e) => setField('game', e.target.value)}
            >
              <option value="all">All games</option>
              {games.map((name) => (<option key={name} value={name}>{name}</option>))}
            </select>
          </div>
          {activeFilters.length > 0 && (
            <button type="button" className="clear-filters" onClick={onClear}>Clear</button>
          )}
        </div>
      )}
    </div>
  );
};

export default TournamentFilterBar;
