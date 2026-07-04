import React from 'react';
import './GameTracker.css';

// Round-by-round tracker body: the results feed (optionally scoped to one
// round) + who's still alive. The round-pill strip itself lives in
// WaitingRoom.js, since it doubles as the nav between this view and the live
// Bracket.
const GameTracker = ({ seeds = [], results = [], roundLabel }) => {
  const shown = roundLabel ? results.filter((r) => r.round === roundLabel) : results;

  return (
    <div className="gt-tracker">
      <div className="gt-section-title">{roundLabel ? `${roundLabel} results` : 'Recent results'}</div>
      <div className="gt-results">
        {shown.length === 0 && <p className="gt-empty">No results tracked for this round yet.</p>}
        {shown.map((r, i) => (
          <div className="gt-result-row" key={`${r.winner}-${r.loser}-${i}`}>
            <div className="gt-result-top">
              <span className="gt-result-winner">{r.winner}</span>
            </div>
            <div className="gt-result-bottom">
              <span className="gt-result-meta">def. {r.loser} &middot; {r.score}</span>
              <span className="gt-result-round">{r.round}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="gt-section-title">Still alive</div>
      <div className="gt-alive">
        {seeds.length === 0 && <p className="gt-empty">Seeding not available yet.</p>}
        {seeds.map((p) => (
          <div className="gt-alive-row" key={p.seed}>
            <span className="gt-alive-seed">{p.seed}</span>
            <span className="gt-alive-name">{p.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default GameTracker;
