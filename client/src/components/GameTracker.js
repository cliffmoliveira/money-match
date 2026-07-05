import React from 'react';
import './GameTracker.css';
import { PlayerName } from './Bracket';

// Round-by-round tracker body: the results feed (optionally scoped to one
// round) + who's still alive. The round-pill strip itself lives in
// WaitingRoom.js, since it doubles as the nav between this view and the live
// Bracket. Result cards reuse the same bnode-* classes as the live Top 8
// bracket (winner bold/white with a star, loser dimmed, green/red scores,
// sponsor in subscript above the tag) so history reads as one visual family
// with the bracket instead of a plainer, disconnected list.
const GameTracker = ({ seeds = [], results = [], roundLabel }) => {
  const shown = roundLabel ? results.filter((r) => r.round === roundLabel) : results;

  return (
    <div className="gt-tracker">
      <div className="gt-section-title">{roundLabel ? `${roundLabel} results` : 'Recent results'}</div>
      <div className="gt-results">
        {shown.length === 0 && <p className="gt-empty">No results tracked for this round yet.</p>}
        {shown.map((r, i) => (
          <div className="gt-result-row" key={`${r.winner}-${r.loser}-${i}`}>
            <div className="gt-result-head">{r.round}</div>
            <div className="bnode-row gt-result-player win">
              <span className="gt-result-name-group">
                <span className="gt-result-star" aria-hidden="true">★</span>
                <span className="bnode-name bnode-name-stack"><PlayerName name={r.winner} /></span>
              </span>
              <span className="bnode-score">{r.winnerScore}</span>
            </div>
            <div className="bnode-row gt-result-player loss">
              <span className="gt-result-name-group">
                <span className="bnode-name bnode-name-stack"><PlayerName name={r.loser} /></span>
              </span>
              <span className="bnode-score">{r.loserScore}</span>
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
