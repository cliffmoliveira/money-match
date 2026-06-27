import React from 'react';
import './ExhibitionSection.css';

const STATE_BADGE = {
  open:    { label: 'LIVE',    cls: 'ex-badge-live' },
  closed:  { label: 'IN PROGRESS', cls: 'ex-badge-live' },
  settled: { label: 'FINAL',   cls: 'ex-badge-final' },
};

const ExhibitionCard = ({ ex }) => {
  const badge = STATE_BADGE[ex.state] || {};
  const loser = ex.winner_name
    ? (ex.winner_name === ex.player1_name ? ex.player2_name : ex.player1_name)
    : null;

  return (
    <div className={`ex-card${ex.state === 'settled' ? ' ex-settled' : ''}`}>
      <div className="ex-card-top">
        <span className="ex-label">⭐ Exhibition</span>
        <div className="ex-card-meta">
          {ex.game_name && <span className="ex-game">{ex.game_name}</span>}
          {ex.tournament_name && <span className="ex-tournament">{ex.tournament_name}</span>}
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

      {ex.state === 'settled' && ex.winner_name && (
        <div className="ex-result">
          {ex.winner_name} def. {loser}
        </div>
      )}

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
        {exhibitions.map((ex) => <ExhibitionCard key={ex.id} ex={ex} />)}
      </div>
    </section>
  );
};

export default ExhibitionSection;
