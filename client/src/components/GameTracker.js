import React from 'react';
import './GameTracker.css';
import { PlayerName } from './Bracket';

// Round-by-round tracker body: the results feed (optionally scoped to one
// round) + who's still alive. The round-pill strip itself lives in
// WaitingRoom.js, since it doubles as the nav between this view and the live
// Bracket. Each result is one scoreboard-style row - winner (name + star)
// on the left, loser on the right, scores flanking a "VS" in the middle -
// reusing the bracket's name/sponsor styling (Bracket.js's PlayerName) so
// history still reads as the same visual family, without repeating the
// round name on every row (it's already the selected pill above).
const GameTracker = ({ seeds = [], results = [], roundLabel }) => {
  const shown = roundLabel ? results.filter((r) => r.round === roundLabel) : results;

  return (
    <div className="gt-tracker">
      <div className="gt-section-title">{roundLabel ? `${roundLabel} results` : 'Recent results'}</div>
      <div className="gt-results">
        {shown.length === 0 && <p className="gt-empty">No results tracked for this round yet.</p>}
        {shown.map((r, i) => (
          <div className="gt-result-row" key={`${r.winner}-${r.loser}-${i}`}>
            <span className="gt-result-side gt-result-winner">
              <span className="gt-result-star" aria-hidden="true">★</span>
              <span className="bnode-name-stack"><PlayerName name={r.winner} /></span>
            </span>
            <span className="gt-result-score gt-result-score-win">{r.winnerScore}</span>
            <span className="gt-result-vs">VS</span>
            <span className="gt-result-score gt-result-score-loss">{r.loserScore}</span>
            <span className="gt-result-side gt-result-loser">
              <span className="bnode-name-stack"><PlayerName name={r.loser} /></span>
            </span>
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
