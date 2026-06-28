import React, { useState } from 'react';
import './ExhibitionSection.css';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';

const STATE_BADGE = {
  open:    { label: 'LIVE',        cls: 'ex-badge-live' },
  closed:  { label: 'IN PROGRESS', cls: 'ex-badge-live' },
  settled: { label: 'FINAL',       cls: 'ex-badge-final' },
};

const SmallLogo = ({ candidates, alt, className, style }) => {
  const [index, setIndex] = useState(0);
  const src = candidates[index];
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      onError={() => setIndex((i) => i + 1)}
    />
  );
};

const GameLogo = ({ name, height = 28 }) => {
  if (!name) return null;
  const { svg, avif, webp, png, jpg, jpeg } = getGameLogoSources(name);
  const candidates = [svg, avif, webp, png, jpg, jpeg].filter(Boolean);
  if (!candidates.length) return null;
  return (
    <SmallLogo
      candidates={candidates}
      alt={getGameAlt(name)}
      className="ex-logo-game"
      style={getGameLogoStyle(name, height)}
    />
  );
};

const TournamentLogo = ({ name, logoUrl, height = 24 }) => {
  if (!name && !logoUrl) return null;
  const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name || '');
  // Local assets first — remote logo_url is often a small platform favicon
  const candidates = [avif, webp, png, jpg, jpeg, logoUrl].filter(Boolean);
  if (!candidates.length) return null;
  return (
    <SmallLogo
      candidates={candidates}
      alt={getTournamentAlt(name || '')}
      className="ex-logo-tournament"
      style={getTournamentLogoStyle(name || '', height)}
    />
  );
};

// Table layout — matches PastResults desktop table (reuses PastResults.css classes)
const ExhibitionTable = ({ exhibitions }) => (
  <>
    <div className="results-table-container">
      <table className="results-table">
        <thead>
          <tr>
            <th>Tournament</th>
            <th>Date</th>
            <th className="game">Game</th>
            <th>Winner</th>
            <th>Score</th>
            <th>Loser</th>
          </tr>
        </thead>
        <tbody>
          {exhibitions.map((ex) => {
            const loser = ex.winner_name === ex.player1_name ? ex.player2_name : ex.player1_name;
            const dateStr = ex.event_date
              ? new Date(ex.event_date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
              : '—';
            return (
              <tr key={ex.id} className="result-row">
                <td className="tournament-name">
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                    <TournamentLogo name={ex.tournament_name} logoUrl={ex.tournament_logo_url} height={64} />
                    <span style={{ textAlign: 'center' }}>{ex.tournament_name}</span>
                  </div>
                </td>
                <td className="date" data-label="Date">{dateStr}</td>
                <td className="game" data-label="Game">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
                    <GameLogo name={ex.game_name} height={56} />
                  </div>
                </td>
                <td className="winner" data-label="Winner">{ex.winner_name || '?'}</td>
                <td className="score" data-label="Score">
                  {ex.winner_score != null ? `${ex.winner_score} – ${ex.loser_score}` : '—'}
                </td>
                <td className="loser" data-label="Loser">{loser || '?'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    {/* Mobile cards — same structure as PastResults */}
    <div className="results-cards">
      {exhibitions.map((ex) => {
        const loser = ex.winner_name === ex.player1_name ? ex.player2_name : ex.player1_name;
        const dateStr = ex.event_date
          ? new Date(ex.event_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : null;
        return (
          <div className="result-card" key={ex.id}>
            <TournamentLogo name={ex.tournament_name} logoUrl={ex.tournament_logo_url} height={30} />
            <div className="rc-body">
              <div className="rc-result">
                <span className="rc-winner">{ex.winner_name || '?'}</span>
                <span className="rc-loser">{loser || '?'}</span>
              </div>
              <div className="rc-meta">
                {[ex.game_name, dateStr, ex.tournament_name].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  </>
);

// Compact row — used on Home page for settled exhibitions
const SettledRow = ({ ex }) => {
  const loser = ex.winner_name === ex.player1_name ? ex.player2_name : ex.player1_name;
  const dateStr = ex.event_date
    ? new Date(ex.event_date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;
  const meta = [ex.tournament_name, dateStr].filter(Boolean).join(' · ');

  return (
    <div className="ex-result-row">
      <div className="ex-result-logos">
        <GameLogo name={ex.game_name} />
        <TournamentLogo name={ex.tournament_name} logoUrl={ex.tournament_logo_url} />
      </div>
      <div className="ex-result-body">
        <div className="ex-result-match">
          <span className="ex-result-winner">{ex.winner_name || '?'}</span>
          <span className="ex-result-def">def.</span>
          <span className="ex-result-loser">{loser || '?'}</span>
        </div>
        {meta && <div className="ex-result-meta">{meta}</div>}
      </div>
    </div>
  );
};

// Live/open exhibitions: gold card format
const ExhibitionCard = ({ ex }) => {
  const badge = STATE_BADGE[ex.state] || {};

  return (
    <div className="ex-card">
      <div className="ex-card-top">
        <span className="ex-label">⭐ Exhibition</span>
        <div className="ex-card-meta">
          {ex.game_name && (
            <span className="ex-game">
              <GameLogo name={ex.game_name} />
              {ex.game_name}
            </span>
          )}
          {ex.tournament_name && (
            <span className="ex-tournament">
              <TournamentLogo name={ex.tournament_name} logoUrl={ex.tournament_logo_url} />
              {ex.tournament_name}
            </span>
          )}
          {badge.label && <span className={`ex-badge ${badge.cls}`}>{badge.label}</span>}
        </div>
      </div>

      <div className="ex-matchup">
        <span className={`ex-player${ex.winner_name === ex.player1_name ? ' ex-winner' : ex.winner_name ? ' ex-loser' : ''}`}>
          {ex.player1_name}
          {ex.winner_name === ex.player1_name && <span className="ex-crown">👑</span>}
        </span>
        <span className="ex-vs">VS</span>
        <span className={`ex-player${ex.winner_name === ex.player2_name ? ' ex-winner' : ex.winner_name ? ' ex-loser' : ''}`}>
          {ex.player2_name}
          {ex.winner_name === ex.player2_name && <span className="ex-crown">👑</span>}
        </span>
      </div>

      {ex.notes && <div className="ex-notes">{ex.notes}</div>}
    </div>
  );
};

// layout="table" → desktop table + mobile cards (Results page)
// layout="cards" → compact rows (Home page, default)
const ExhibitionSection = ({ exhibitions, title = 'Exhibitions', layout = 'cards' }) => {
  if (!exhibitions || exhibitions.length === 0) return null;

  const settled = exhibitions.filter((ex) => ex.state === 'settled');
  const active = exhibitions.filter((ex) => ex.state !== 'settled');

  return (
    <section className="ex-section">
      <h2 className="ex-section-title">{title}</h2>
      {active.length > 0 && (
        <div className="ex-list" style={{ marginBottom: settled.length ? 16 : 0 }}>
          {active.map((ex) => <ExhibitionCard key={ex.id} ex={ex} />)}
        </div>
      )}
      {settled.length > 0 && (
        layout === 'table'
          ? <ExhibitionTable exhibitions={settled} />
          : <div className="ex-list">
              {settled.map((ex) => <SettledRow key={ex.id} ex={ex} />)}
            </div>
      )}
    </section>
  );
};

export default ExhibitionSection;
