import React, { useState } from 'react';
import './ExhibitionSection.css';
import { getGameLogoSources, getGameAlt } from '../utils/gameLogos';
import { getTournamentLogoSources, getTournamentAlt } from '../utils/tournamentLogos';

const STATE_BADGE = {
  open:    { label: 'LIVE',        cls: 'ex-badge-live' },
  closed:  { label: 'IN PROGRESS', cls: 'ex-badge-live' },
  settled: { label: 'FINAL',       cls: 'ex-badge-final' },
};

const SmallLogo = ({ candidates, alt, className }) => {
  const [index, setIndex] = useState(0);
  const src = candidates[index];
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setIndex((i) => i + 1)}
    />
  );
};

const GameLogo = ({ name }) => {
  if (!name) return null;
  const { svg, avif, webp, png, jpg, jpeg } = getGameLogoSources(name);
  const candidates = [svg, avif, webp, png, jpg, jpeg].filter(Boolean);
  if (!candidates.length) return null;
  return <SmallLogo candidates={candidates} alt={getGameAlt(name)} className="ex-logo-game" />;
};

const TournamentLogo = ({ name, logoUrl }) => {
  if (!name && !logoUrl) return null;
  const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name || '');
  const candidates = [logoUrl, avif, webp, png, jpg, jpeg].filter(Boolean);
  if (!candidates.length) return null;
  return <SmallLogo candidates={candidates} alt={getTournamentAlt(name || '')} className="ex-logo-tournament" />;
};

// Settled exhibitions: table-row style matching PastResults cards
const SettledRow = ({ ex }) => {
  const loser = ex.winner_name === ex.player1_name ? ex.player2_name : ex.player1_name;
  const dateStr = ex.event_date
    ? new Date(ex.event_date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;
  const meta = [ex.game_name, ex.tournament_name, dateStr].filter(Boolean).join(' · ');

  return (
    <div className="result-card">
      <TournamentLogo name={ex.tournament_name} logoUrl={ex.tournament_logo_url} height={30} />
      <div className="rc-body">
        <div className="rc-result">
          <span className="rc-winner">{ex.winner_name || '?'}</span>
          <span className="rc-score" style={{ color: 'var(--muted)', fontSize: '12px', fontWeight: 600 }}>def.</span>
          <span className="rc-loser">{loser || '?'}</span>
        </div>
        {meta && <div className="rc-meta">{meta}</div>}
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

const ExhibitionSection = ({ exhibitions, title = 'Exhibitions' }) => {
  if (!exhibitions || exhibitions.length === 0) return null;
  return (
    <section className="ex-section">
      <h2 className="ex-section-title">{title}</h2>
      <div className="ex-list">
        {exhibitions.map((ex) =>
          ex.state === 'settled'
            ? <SettledRow key={ex.id} ex={ex} />
            : <ExhibitionCard key={ex.id} ex={ex} />
        )}
      </div>
    </section>
  );
};

export default ExhibitionSection;
