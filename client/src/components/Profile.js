import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Profile.css';
import '../components/Home.css';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
import { splitPlayerName } from '../utils/playerName';
import { fmAmount } from '../utils/money';
import { apiFetch } from '../utils/api';

// Mirrors Home.js's own TournamentLogo/GameLogo/BetPlayerName exactly (same
// bets-grid/bet-card markup and CSS classes, see Home.css) so pick history
// here looks identical to the "Your Picks" cards on Home - including
// falling back to the tournament's own start.gg logo_url when there's no
// bundled local asset, which is what actually put a real image on VSFighting
// et al. on Home while this page showed nothing for them.
const TournamentLogo = ({ name, logoUrl, height = 24 }) => {
  const [index, setIndex] = useState(0);
  if (!name) return null;
  const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name);
  const candidates = [avif, webp, png, jpg, jpeg, logoUrl].filter(Boolean);
  const src = candidates[index];
  if (!src) return <span>{name}</span>;
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
  const [failed, setFailed] = useState(false);
  if (!name) return null;
  const candidates = Object.values(getGameLogoSources(name)).filter(Boolean);
  const src = candidates[index];
  if (failed || !src) return <span>{name}</span>;
  return (
    <img
      src={src}
      alt={getGameAlt(name)}
      style={getGameLogoStyle(name, height)}
      onError={() => (index + 1 < candidates.length ? setIndex(index + 1) : setFailed(true))}
    />
  );
};

const BetPlayerName = ({ name }) => {
  if (!name) return <span className="bet-player-tag">TBD</span>;
  const { sponsor, tag } = splitPlayerName(name);
  return (
    <span className="bet-player-name-stack">
      {sponsor && <span className="bet-player-sponsor">{sponsor}</span>}
      <span className="bet-player-tag">{tag}</span>
    </span>
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
        if (!bRes.ok) throw new Error('Failed to load picks.');
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

  const lossCount = settled.length - wonCount;

  const stats = [
    { label: 'FM Net', value: (netCents >= 0 ? '+' : '') + fmAmount(netCents), green: netCents > 0, red: netCents < 0 },
    { label: 'Wins', value: wonCount, green: wonCount > 0 },
    { label: 'Losses', value: lossCount, red: lossCount > 0 },
    { label: 'Accuracy', value: `${Math.round(accuracy * 100)}%` },
    { label: 'Best streak', value: bestStreak },
    { label: 'Total picks', value: liveBets.length },
  ];

  return (
    <div className="profile-page">
      <div className="pf-stats">
        {stats.map((s) => (
          <div key={s.label} className={`pf-stat${s.gold ? ' gold' : ''}${s.green ? ' green' : ''}${s.red ? ' red' : ''}`}>
            <div className="pf-stat-value">{s.value}</div>
            <div className="pf-stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Live bet history — full list. Same bets-grid/bet-card markup as
          Home.js's "Your Picks" widget (see Home.css) so this page's cards
          look identical, right down to the tournament logo falling back to
          the event's own start.gg logo_url when there's no bundled asset. */}
      <h2 className="pf-recent-title">Pick history</h2>
      {liveBets.length === 0 ? (
        <p className="pf-muted">No picks yet — head to <Link to="/brackets">Brackets</Link> to place one.</p>
      ) : (
        <div className="bets-grid">
          {liveBets.map((b) => {
            const opp = b.player1_name === b.picked_name ? b.player2_name : b.player1_name;
            const statusClass = b.state === 'won' ? 'win' : b.state === 'lost' ? 'loss' : b.state === 'refunded' ? 'refunded' : 'pending';
            const statusLabel = b.state === 'won' ? 'Won' : b.state === 'lost' ? 'Lost' : b.state === 'refunded' ? 'Refunded' : 'Pending';
            const stakeFm = fmAmount(b.amount_cents);
            const resultCents = b.state === 'won' ? (b.payout_cents - b.amount_cents) : b.state === 'lost' ? -b.amount_cents : null;
            return (
              <div key={b.id} className="bet-card">
                <div className="bet-row bet-row-top">
                  <div className="bet-tournament">
                    <TournamentLogo name={b.tournament_name} logoUrl={b.tournament_logo_url} height={20} />
                    <span className="bet-tournament-name">{b.tournament_name}</span>
                  </div>
                  <div className={`bet-outcome ${statusClass}`}>
                    {statusLabel}
                    {resultCents != null && (
                      <span className="bet-result">{resultCents >= 0 ? ' +' : ' −'}{fmAmount(Math.abs(resultCents))} FM</span>
                    )}
                  </div>
                </div>
                <div className="bet-row bet-row-bottom">
                  <div className="bet-game">
                    <GameLogo name={b.game_name} height={36} />
                  </div>
                  <div className="bet-player"><BetPlayerName name={b.picked_name} /></div>
                  <div className="bet-amount">
                    <span className="bet-amount-label">Original wager</span>
                    <span className="bet-amount-value">{stakeFm} FM</span>
                  </div>
                </div>
                {(opp || b.round_text) && (
                  <div className="bet-row bet-row-meta">
                    {b.round_text && <span className="bet-round">{b.round_text}</span>}
                    {opp && <span className="bet-vs">vs <BetPlayerName name={opp} /></span>}
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
