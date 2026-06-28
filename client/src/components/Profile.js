import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Profile.css';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
import { fmAmount } from '../utils/money';
import { apiFetch } from '../utils/api';

const shortTag = (name) => (name && name.includes('|') ? name.split('|').pop().trim() : name);


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
  const [liveBets, setLiveBets] = useState([]);
  const [betsLoading, setBetsLoading] = useState(true);
  const userId = localStorage.getItem('userId');
  const username = localStorage.getItem('username');

  useEffect(() => {
    if (!userId) { setError('Not logged in.'); setLoading(false); setBetsLoading(false); return; }
    let active = true;
    (async () => {
      try {
        const [pRes, bRes] = await Promise.all([
          fetch(`/api/pickem/profile?userId=${userId}`),
          apiFetch(`/api/live/bets?userId=${userId}`),
        ]);
        if (!pRes.ok) throw new Error('Failed to load profile.');
        if (active) {
          setData(await pRes.json());
          if (bRes.ok) setLiveBets(await bRes.json());
        }
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) { setLoading(false); setBetsLoading(false); }
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
      <div className="pf-stats">
        {stats.map((s) => (
          <div key={s.label} className={`pf-stat${s.gold ? ' gold' : ''}`}>
            <div className="pf-stat-value">{s.value}</div>
            <div className="pf-stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Live bet history — full list */}
      <h2 className="pf-recent-title">Bet history</h2>
      {betsLoading ? (
        <p className="pf-muted">Loading bets…</p>
      ) : liveBets.length === 0 ? (
        <p className="pf-muted">No bets yet — head to the <Link to="/live">Live bracket</Link> to place one.</p>
      ) : (
        <div className="pf-picks">
          {liveBets.map((b) => {
            const picked = shortTag(b.picked_name);
            const opp = shortTag(
              b.player1_name === b.picked_name ? b.player2_name : b.player1_name
            );
            const statusClass = b.state === 'won' ? 'win' : b.state === 'lost' ? 'loss' : 'pending';
            const statusLabel = b.state === 'won' ? 'WON' : b.state === 'lost' ? 'LOST' : b.state === 'refunded' ? 'REFUNDED' : 'PENDING';
            const stakeFm = fmAmount(b.amount_cents);
            const odds = b.locked_odds != null ? Number(b.locked_odds).toFixed(2) : null;
            const payoutFm = b.state === 'won' ? fmAmount(b.payout_cents) : null;
            return (
              <div key={b.id} className="bet-card">
                <div className="bet-row bet-row-top">
                  <div className="bet-tournament">
                    <TournamentLogo name={b.tournament_name} height={20} />
                    <span className="bet-tournament-name">{b.tournament_name || '—'}</span>
                  </div>
                  {b.round_text && <span className="bet-kind">{b.round_text}</span>}
                  <div className={`bet-outcome ${statusClass}`}>{statusLabel}</div>
                </div>
                <div className="bet-row bet-row-bottom">
                  <div className="bet-game">
                    <GameLogo name={b.game_name} height={24} />
                  </div>
                  <div className="bet-player pf-bet-pick">{picked}{opp ? ` vs ${opp}` : ''}</div>
                  <div className="pf-bet-stake">
                    <span className="pf-bet-amount">{stakeFm} FM</span>
                    {odds && <span className="pf-bet-odds">@ {odds}×</span>}
                    {payoutFm && <span className="pf-bet-payout">→ {payoutFm} FM</span>}
                  </div>
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
