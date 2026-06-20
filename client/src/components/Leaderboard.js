import React, { useEffect, useState } from 'react';
import './Leaderboard.css';

// Pick'em leaderboard (spec §7.6). v1 = global scope; game/event/season scopes
// are already supported by the API and can get selectors later.
const Leaderboard = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const userId = localStorage.getItem('userId');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/pickem/leaderboard?scope=global&limit=50');
        if (!res.ok) throw new Error('Failed to load leaderboard.');
        if (active) setRows(await res.json());
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <div className="leaderboard-page">
      <div className="lb-head">
        <h1>Ranked Leaderboard</h1>
        <p className="lb-sub">Predict bracket winners — bolder, later-round, against-the-crowd calls score more.</p>
      </div>

      {loading ? (
        <p className="lb-muted">Loading…</p>
      ) : error ? (
        <p className="error-message">{error}</p>
      ) : rows.length === 0 ? (
        <p className="lb-muted">No picks scored yet — make some on the Live bracket and check back.</p>
      ) : (
        <div className="lb-table" role="table">
          <div className="lb-row lb-colhead" role="row">
            <span className="lb-rank">#</span>
            <span className="lb-user">Gamer Tag</span>
            <span className="lb-num">Points</span>
            <span className="lb-num">Acc</span>
            <span className="lb-num">Streak</span>
          </div>
          {rows.map((r) => (
            <div key={r.user_id} className={`lb-row${String(r.user_id) === userId ? ' me' : ''}`} role="row">
              <span className="lb-rank">{r.rank}</span>
              <span className="lb-user">{r.username}</span>
              <span className="lb-num lb-points">{r.points.toLocaleString()}</span>
              <span className="lb-num">{Math.round((r.accuracy || 0) * 100)}%</span>
              <span className="lb-num">{r.best_streak}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Leaderboard;
