import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Profile.css';

// Pick'em profile (spec §7.6): coins, points, accuracy, streaks, recent picks.
const Profile = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const userId = localStorage.getItem('userId');
  const username = localStorage.getItem('username');

  useEffect(() => {
    if (!userId) { setError('Not logged in.'); setLoading(false); return; }
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/pickem/profile?userId=${userId}`);
        if (!res.ok) throw new Error('Failed to load profile.');
        if (active) setData(await res.json());
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [userId]);

  if (loading) return <div className="profile-page"><p className="pf-muted">Loading…</p></div>;
  if (error) return <div className="profile-page"><p className="error-message">{error}</p></div>;

  const stats = [
    { label: 'Points', value: data.points.toLocaleString(), gold: true },
    { label: 'Accuracy', value: `${Math.round((data.accuracy || 0) * 100)}%` },
    { label: 'Current streak', value: data.current_streak },
    { label: 'Best streak', value: data.best_streak },
    { label: 'Total picks', value: data.total_picks },
  ];

  return (
    <div className="profile-page">
      <div className="pf-head">
        <div>
          <h1>{data.display_name || username || 'You'} &middot; Picks</h1>
          <p className="pf-sub">{data.correct_count}/{data.total_picks} winners called.</p>
        </div>
        <Link to="/account" className="pf-edit">Edit profile</Link>
      </div>

      <div className="pf-stats">
        {stats.map((s) => (
          <div key={s.label} className={`pf-stat${s.gold ? ' gold' : ''}`}>
            <div className="pf-stat-value">{s.value}</div>
            <div className="pf-stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <h2 className="pf-recent-title">Recent picks</h2>
      {data.picks.length === 0 ? (
        <p className="pf-muted">No picks yet — head to the Live bracket and call some winners.</p>
      ) : (
        <div className="pf-picks">
          {data.picks.map((p, i) => (
            <div key={`${p.market_id}-${i}`} className={`pf-pick ${p.result}`}>
              <span className={`pf-pick-badge ${p.result}`}>{p.result}</span>
              <span className="pf-pick-meta">Match #{p.market_id}</span>
              <span className="pf-pick-reward">
                {p.result === 'correct' ? `+${p.points_awarded} pts` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Profile;
