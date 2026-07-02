import React, { useEffect, useState } from 'react';
import './Leaderboard.css';
import { fmAmount } from '../utils/money';

// Deterministic hue from a gamertag so each fallback avatar gets a stable,
// distinct color across reloads.
const hueFor = (s) => {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
};

// Avatar beside a gamertag: the user's uploaded image when present, otherwise a
// colored circle with their first initial (demo users have no avatar set).
const RankAvatar = ({ src, name }) => {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img className="lb-avatar" src={src} alt="" onError={() => setFailed(true)} />;
  }
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <span className="lb-avatar lb-avatar-fallback" style={{ background: `hsl(${hueFor(name)} 52% 34%)` }} aria-hidden="true">
      {initial}
    </span>
  );
};

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
        <h1 className="sr-only">Ranked Leaderboard</h1>
      </div>

      {loading ? (
        <p className="lb-muted">Loading…</p>
      ) : error ? (
        <p className="error-message">{error}</p>
      ) : rows.length === 0 ? (
        <p className="lb-muted">No picks scored yet — make some on the Brackets page and check back.</p>
      ) : (
        <div className="lb-table" role="table">
          <div className="lb-row lb-colhead" role="row">
            <span className="lb-rank">#</span>
            <span className="lb-user"><span className="lb-avatar-spacer" aria-hidden="true" /><span className="lb-name">Gamertag</span></span>
            <span className="lb-num">FM</span>
            <span className="lb-num">Acc</span>
            <span className="lb-num">Streak</span>
          </div>
          {rows.map((r) => (
            <div key={r.user_id} className={`lb-row${String(r.user_id) === userId ? ' me' : ''}`} role="row">
              <span className="lb-rank">{r.rank}</span>
              <span className="lb-user">
                <RankAvatar src={r.avatar} name={r.username} />
                <span className="lb-name">{r.username}</span>
              </span>
              <span className="lb-num lb-points">{fmAmount(r.balance_cents)}</span>
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
