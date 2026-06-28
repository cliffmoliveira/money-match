import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Profile.css';

const shortTag = (name) => (name && name.includes('|') ? name.split('|').pop().trim() : name);

const BADGE = { correct: 'CORRECT', incorrect: 'INCORRECT', pending: 'PENDING', void: 'VOID' };

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
        <div className="pf-head-actions">
          <Link to="/leaderboard" className="pf-ranks-link">Leaderboard</Link>
          <Link to="/account" className="pf-edit">Edit profile</Link>
        </div>
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
          {data.picks.map((p, i) => {
            const picked = shortTag(p.picked_name) || `#${p.picked_player_id}`;
            const opp = shortTag(p.opp_name);
            return (
              <div key={`${p.market_id}-${i}`} className={`pf-pick ${p.result}`}>
                <div className="pf-pick-top">
                  <span className={`pf-pick-badge ${p.result}`}>{BADGE[p.result] || p.result}</span>
                  {p.result === 'correct' && (
                    <span className="pf-pick-reward">+{p.points_awarded} pts</span>
                  )}
                </div>
                <div className="pf-pick-matchup">
                  <span className="pf-pick-picked">{picked}</span>
                  {opp && <><span className="pf-pick-vs"> vs </span><span className="pf-pick-opp">{opp}</span></>}
                </div>
                {(p.game_name || p.round_text || p.tournament_name) && (
                  <div className="pf-pick-context">
                    {p.game_name && <span className="pf-pick-game">{p.game_name}</span>}
                    {p.round_text && <><span className="pf-pick-dot">·</span><span>{p.round_text}</span></>}
                    {p.tournament_name && <><span className="pf-pick-dot">·</span><span>{p.tournament_name}</span></>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Profile;
