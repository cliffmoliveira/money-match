import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Profile.css';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';

const shortTag = (name) => (name && name.includes('|') ? name.split('|').pop().trim() : name);

const BADGE = { correct: 'CORRECT', incorrect: 'INCORRECT', pending: 'PENDING', void: 'VOID' };

const TournamentLogo = ({ name, height = 24 }) => {
  const [index, setIndex] = useState(0);
  if (!name) return null;
  const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name);
  const candidates = [avif, webp, png, jpg, jpeg].filter(Boolean);
  const src = candidates[index];
  if (!src) return null;
  return (
    <img
      src={src}
      alt={getTournamentAlt(name)}
      style={getTournamentLogoStyle(name, height)}
      title={name}
      onError={() => setIndex((i) => i + 1)}
    />
  );
};

const GameLogo = ({ name, height = 24 }) => {
  const [index, setIndex] = useState(0);
  if (!name) return null;
  const candidates = Object.values(getGameLogoSources(name)).filter(Boolean);
  const src = candidates[index];
  if (!src) return null;
  return (
    <img
      src={src}
      alt={getGameAlt(name)}
      style={getGameLogoStyle(name, height)}
      onError={() => { if (index + 1 < candidates.length) setIndex(index + 1); }}
    />
  );
};

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
            const outcomeClass = p.result === 'correct' ? 'win' : p.result === 'incorrect' ? 'loss' : 'pending';
            return (
              <div key={`${p.market_id}-${i}`} className="bet-card">
                <div className="bet-row bet-row-top">
                  <div className="bet-tournament">
                    <TournamentLogo name={p.tournament_name} height={20} />
                    <span className="bet-tournament-name">{p.tournament_name || '—'}</span>
                  </div>
                  {p.round_text && <span className="bet-kind">{p.round_text}</span>}
                  <div className={`bet-outcome ${outcomeClass}`}>
                    {BADGE[p.result] || p.result}
                  </div>
                </div>
                <div className="bet-row bet-row-bottom">
                  <div className="bet-game">
                    <GameLogo name={p.game_name} height={24} />
                  </div>
                  <div className="bet-player">{picked}{opp ? ` vs ${opp}` : ''}</div>
                  {p.result === 'correct' && p.points_awarded > 0 && (
                    <div className="bet-amount">+{p.points_awarded} pts</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Profile;
