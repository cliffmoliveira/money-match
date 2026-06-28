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

const Profile = () => {
  const [liveBets, setLiveBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const userId = localStorage.getItem('userId');

  useEffect(() => {
    if (!userId) { setError('Not logged in.'); setLoading(false); return; }
    let active = true;
    (async () => {
      try {
        const bRes = await apiFetch(`/api/live/bets?userId=${userId}`);
        if (!bRes.ok) throw new Error('Failed to load bets.');
        if (active) setLiveBets(await bRes.json());
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

  // Compute stats from live bets
  const settled = liveBets.filter(b => b.state === 'won' || b.state === 'lost');
  const wonCount = settled.filter(b => b.state === 'won').length;
  const accuracy = settled.length > 0 ? wonCount / settled.length : 0;
  const netCents = liveBets.reduce((sum, b) => {
    if (b.state === 'won') return sum + (b.payout_cents - b.amount_cents);
    if (b.state === 'lost') return sum - b.amount_cents;
    return sum;
  }, 0);

  // Current streak: walk newest-first through settled bets
  let currentStreak = 0;
  let streakState = null;
  for (const b of liveBets) {
    if (b.state !== 'won' && b.state !== 'lost') continue;
    if (streakState === null) { streakState = b.state; currentStreak = 1; }
    else if (b.state === streakState) currentStreak++;
    else break;
  }

  // Best win streak: walk oldest-first
  let bestStreak = 0;
  let run = 0;
  for (const b of [...liveBets].reverse()) {
    if (b.state === 'won') { run++; bestStreak = Math.max(bestStreak, run); }
    else if (b.state === 'lost') run = 0;
  }

  const stats = [
    { label: 'FM Net', value: (netCents >= 0 ? '+' : '') + fmAmount(netCents), gold: netCents > 0 },
    { label: 'Accuracy', value: `${Math.round(accuracy * 100)}%` },
    { label: 'Current streak', value: currentStreak },
    { label: 'Best streak', value: bestStreak },
    { label: 'Total bets', value: liveBets.length },
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
      {liveBets.length === 0 ? (
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
                    <span className={`pf-bet-amount${b.state === 'lost' ? ' loss' : ''}`}>{stakeFm} FM</span>
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
