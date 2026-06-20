import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Home.css';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
import Countdown from './Countdown';
import { fm as fmt, fmAmount } from '../utils/money';

// Hoisted to module scope so their component identity is stable across Home
// re-renders — defining them inside the parent recreates the type every render,
// remounting each logo and making the images flicker.
const TournamentLogo = ({ name, height = 24 }) => {
  const [index, setIndex] = useState(0);
  if (!name) return null;
  const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name);
  const candidates = [avif, webp, png, jpg, jpeg].filter(Boolean);
  const src = candidates[index];
  if (!src) return <span>{name}</span>;
  return (
    <img
      src={src}
      alt={getTournamentAlt(name)}
      style={getTournamentLogoStyle(name, height)}
      title={src}
      onError={() => { if (index + 1 < candidates.length) setIndex(index + 1); }}
    />
  );
};

const GameLogo = ({ name, height = 24, customStyles = {} }) => {
  const [index, setIndex] = useState(0);
  if (!name) return null;
  const candidates = Object.values(getGameLogoSources(name)).filter(Boolean);
  const src = candidates[index];
  if (!src) return <span>{name}</span>;
  return (
    <img
      src={src}
      alt={getGameAlt(name)}
      style={getGameLogoStyle(name, height, customStyles)}
      onError={() => { if (index + 1 < candidates.length) setIndex(index + 1); }}
    />
  );
};

const Home = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [upcoming, setUpcoming] = useState([]);
  const [allTournaments, setAllTournaments] = useState([]);
  const [recentChampions, setRecentChampions] = useState([]);
  const [games, setGames] = useState([]);
  const [players, setPlayers] = useState([]);

  const [bets, setBets] = useState([]);
  const [betsLoading, setBetsLoading] = useState(false);

  // Live betting + wallet — the marquee feature, surfaced here as a hero.
  const [liveMarkets, setLiveMarkets] = useState([]);
  const [liveBets, setLiveBets] = useState([]);
  const [balanceCents, setBalanceCents] = useState(null);

  const userId = localStorage.getItem('userId');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      const [tournamentsRes, allTournamentsRes, pastRes, gamesRes, playersRes] = await Promise.all([
        fetch('/api/tournaments'),
        fetch('/api/tournaments/all'),
        fetch('/api/past-results'),
        fetch('/api/games'),
        fetch('/api/players')
      ]);
      if (!tournamentsRes.ok || !allTournamentsRes.ok || !pastRes.ok || !gamesRes.ok || !playersRes.ok) {
        throw new Error('Failed to load homepage data');
      }
      return {
        tournaments: await tournamentsRes.json(),
        allTournamentsData: await allTournamentsRes.json(),
        past: await pastRes.json(),
        gamesData: await gamesRes.json(),
        playersData: await playersRes.json(),
      };
    };

    // A few automatic retries with backoff so a brief API blip self-heals
    // instead of stranding the page; the error UI also offers a manual Retry.
    const run = async () => {
      setLoading(true);
      setError(null);
      const MAX = 4;
      for (let attempt = 1; attempt <= MAX && !cancelled; attempt++) {
        try {
          const { tournaments, allTournamentsData, past, gamesData, playersData } = await fetchOnce();
          if (cancelled) return;
          setGames(gamesData);
          setPlayers(playersData);
          setAllTournaments(allTournamentsData);
          setUpcoming((tournaments || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date)));
          setRecentChampions(
            (past?.data || [])
              .slice()
              .sort((a, b) => new Date(b.date) - new Date(a.date))
              .slice(0, 6)
              .map((r) => ({
                tournament: r.tournament,
                date: r.date,
                game: r.game,
                winner: r.winner,
                loser: r.loser,
                score: `${r.winnerRoundsWon}-${r.loserRoundsWon}`,
              }))
          );
          setError(null);
          setLoading(false);
          return;
        } catch (err) {
          console.error(`Home load error (attempt ${attempt}/${MAX}):`, err.message);
          if (attempt === MAX) {
            if (!cancelled) {
              setError('Failed to load homepage. Please try again later.');
              setLoading(false);
            }
          } else {
            await new Promise((r) => setTimeout(r, 1200 * attempt)); // 1.2s, 2.4s, 3.6s
          }
        }
      }
    };

    run();
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    const fetchBets = async () => {
      if (!userId) return;
      setBetsLoading(true);
      try {
        const [fRes, lRes] = await Promise.all([
          fetch(`/api/bets?userId=${userId}`),
          fetch(`/api/live/bets?userId=${userId}`),
        ]);
        if (fRes.ok) setBets(await fRes.json());
        if (lRes.ok) setLiveBets(await lRes.json());
      } catch (err) {
        console.error('Bets load error:', err.message);
      } finally {
        setBetsLoading(false);
      }
    };

    fetchBets();
  }, [userId]);

  // Poll live markets + wallet so the "Live Now" hero stays current.
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const reqs = [fetch('/api/live/markets')];
        if (userId) reqs.push(fetch(`/api/wallet?userId=${userId}`));
        const [mRes, wRes] = await Promise.all(reqs);
        if (!active) return;
        if (mRes && mRes.ok) setLiveMarkets(await mRes.json());
        if (wRes && wRes.ok) setBalanceCents((await wRes.json()).balanceCents);
      } catch {
        /* non-fatal — the hero just falls back to its idle state */
      }
    };
    load();
    const id = setInterval(load, 20000);
    return () => { active = false; clearInterval(id); };
  }, [userId]);

  const getGameName = (id) => games.find(g => g.id === id)?.name || id;
  const getPlayerName = (id) => players.find(p => p.id === id)?.name || id;
  const getTournamentName = (id) => allTournaments.find(t => t.id === id)?.name || id;

  if (loading) {
    return <div className="home-container"><div className="skeleton">Loading…</div></div>;
  }

  if (error) {
    return (
      <div className="home-container">
        <div className="error-state">
          <p className="error-message">{error}</p>
          <button className="btn primary" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
        </div>
      </div>
    );
  }

  const spotlight = upcoming?.slice(0, 4);
  const liveNow = (liveMarkets || []).filter((m) => m.state === 'open' || m.state === 'closed');

  // One unified bet list: live per-set bets + futures, normalized to a common
  // shape, with unresolved (pending) bets surfaced first.
  const betStatusRank = { pending: 0, win: 1, loss: 2, refunded: 3 };
  const yourBets = [
    ...(liveBets || []).map((b) => ({
      key: `live-${b.id}`, kind: 'Live',
      tournament: b.tournament_name, game: b.game_name, pick: b.picked_name,
      stake: (b.amount_cents || 0) / 100,
      status: b.state === 'won' ? 'win' : b.state === 'lost' ? 'loss' : b.state === 'refunded' ? 'refunded' : 'pending',
      result: b.state === 'won' ? (b.payout_cents - b.amount_cents) / 100 : b.state === 'lost' ? -(b.amount_cents / 100) : null,
    })),
    ...(bets || []).map((b, i) => ({
      key: `future-${b.id ?? i}`, kind: 'Futures',
      tournament: getTournamentName(b.tournament_id), game: getGameName(b.game_id), pick: getPlayerName(b.player_id),
      stake: Number(b.amount || 0),
      status: b.is_winner === 1 ? 'win' : b.is_winner === 0 ? 'loss' : 'pending',
      result: null,
    })),
  ].sort((a, b) => betStatusRank[a.status] - betStatusRank[b.status]);

  // Stat-strip metrics (logged-in): open bets + 7-day realized P&L from live bets.
  const WEEK_MS = 7 * 24 * 3600 * 1000;
  const openBets =
    (liveBets || []).filter((b) => b.state === 'placed').length +
    (bets || []).filter((b) => b.is_winner == null).length;
  const pnl7Cents = (liveBets || [])
    .filter((b) => b.state === 'won' || b.state === 'lost')
    .filter((b) => { const t = b.created_at ? new Date(b.created_at).getTime() : NaN; return isNaN(t) || Date.now() - t <= WEEK_MS; })
    .reduce((s, b) => s + ((b.payout_cents || 0) - (b.amount_cents || 0)), 0);

  const renderHero = () => {
    // Logged-out: value-prop + funnel CTA.
    if (!userId) {
      return (
        <section className="hero">
          <div className="hero-content">
            <h1>Bet on the FGC.</h1>
            <p>Live, per-set betting on Evo, CEO and every major — plus futures on who takes it all. Play money, real bragging rights.</p>
            <div className="hero-actions">
              <Link to="/signup" className="btn primary">Sign up free</Link>
              <Link to="/login" className="btn">Log in</Link>
            </div>
          </div>
        </section>
      );
    }
    // Logged-in with live action: the marquee hero.
    if (liveNow.length > 0) {
      return (
        <section className="live-hero">
          <div className="live-hero-top">
            <span className="live-hero-badge"><span className="live-dot" /> LIVE NOW</span>
            {balanceCents != null && <span className="live-hero-balance">{fmt(balanceCents)}</span>}
          </div>
          <div className="live-hero-sets">
            {liveNow.slice(0, 3).map((m) => (
              <div key={m.id} className="live-hero-set">
                <span className="live-hero-meta">{m.game_name}{m.round_text ? ` · ${m.round_text}` : ''}</span>
                <div className="live-hero-match">
                  <span className="lh-player">{m.player1_name} <b>{Number(m.p1_live_odds).toFixed(2)}</b></span>
                  <span className="lh-vs">vs</span>
                  <span className="lh-player">{m.player2_name} <b>{Number(m.p2_live_odds).toFixed(2)}</b></span>
                </div>
              </div>
            ))}
          </div>
          <Link to="/live" className="btn live-hero-cta">Watch &amp; bet →</Link>
        </section>
      );
    }
    // Logged-in, nothing live right now.
    return (
      <section className="hero">
        <div className="hero-content">
          <h1>Welcome back.</h1>
          <p>
            No live matches right now.{balanceCents != null && <> Your balance is <strong>{fmt(balanceCents)}</strong>.</>} When a tracked major hits Top 8, live betting opens here.
          </p>
          <div className="hero-actions">
            <Link to="/live" className="btn primary">Live betting</Link>
            <Link to="/future-tournaments" className="btn">Browse futures</Link>
          </div>
        </div>
      </section>
    );
  };
  
  return (
    <div className="home-container">
      {renderHero()}

      {userId && (
        <div className="stat-strip">
          <div className="stat-card">
            <div className="label">Balance</div>
            <div className="value">{balanceCents != null ? fmt(balanceCents) : '—'}</div>
          </div>
          <div className="stat-card">
            <div className="label">Open bets</div>
            <div className="value">{openBets}</div>
          </div>
          <div className="stat-card">
            <div className="label">7-day P&amp;L</div>
            <div className={`value ${pnl7Cents >= 0 ? 'up' : 'down'}`}>
              {pnl7Cents >= 0 ? '+' : '−'}{fmAmount(Math.abs(pnl7Cents))} FM
            </div>
          </div>
        </div>
      )}

      {/* Upcoming Spotlight */}
      {spotlight && spotlight.length > 0 && (
        <section className="spotlight">
          <div className="section-header">
            <h2>Next Up</h2>
            <Link to="/future-tournaments" className="link">See all</Link>
          </div>
          <div className="spotlight-grid">
            {spotlight.map(t => (
              <div key={t.id} className="spotlight-card">
                <div className="spotlight-header">
                  <h3>
                    <TournamentLogo name={t.name} height={24} />
                    <span style={{ marginLeft: '10px' }}>{t.name}</span>
                  </h3>
                </div>
                <div className="spotlight-date">{new Date(t.date + 'T00:00:00').toLocaleDateString()}</div>
                <div className="spotlight-location">
                  {t.location?.city}, {t.location?.country}
                </div>
                <div className="spotlight-games">
                  {(Object.values(t.games || {}) || []).slice(0, 4).map(g => (
                    <span key={g.id} className="pill">{g.name}</span>
                  ))}
                  {Object.values(t.games || {}).length > 4 && (
                    <span className="more-pill">+{Object.values(t.games || {}).length - 4} more</span>
                  )}
                </div>
                <Countdown date={t.date} compact />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Champions */}
      <section className="champions">
        <div className="section-header">
          <h2>Recent Champions</h2>
          <Link to="/past-results" className="link">See all</Link>
        </div>
        <div className="champion-grid">
          {recentChampions.map((c, i) => (
            <div key={i} className="champion-card">
              <div className="champion-game">
                <GameLogo name={c.game} height={32} />
              </div>
              <div className="champion-winner">{c.winner}</div>
              <div className="champion-meta">
                <span className="champion-tournament">{c.tournament}</span>
                <span className="champion-date">{new Date(c.date + 'T00:00:00').toLocaleDateString()}</span>
              </div>
              <div className="champion-score"><b>{c.score}</b> def. {c.loser}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Your Bets — live per-set + futures, unified */}
      {userId && (
        <section className="bets">
          <div className="section-header">
            <h2>Your Bets</h2>
            <Link to="/live" className="link">Place bets</Link>
          </div>
          {betsLoading ? (
            <div className="skeleton">Loading bets…</div>
          ) : yourBets.length === 0 ? (
            <p className="muted">No bets yet.</p>
          ) : (
            <div className="bets-grid">
              {yourBets.slice(0, 6).map((b) => (
                <div key={b.key} className="bet-card">
                  <div className="bet-tournament">
                    <TournamentLogo name={b.tournament} height={20} />
                    <span className="bet-tournament-name">{b.tournament}</span>
                  </div>
                  <span className={`bet-kind ${b.kind === 'Live' ? 'live' : ''}`}>{b.kind}</span>
                  <div className="bet-game">
                    <GameLogo name={b.game} height={24} />
                  </div>
                  <div className="bet-player">{b.pick}</div>
                  <div className="bet-amount">{fmAmount(Math.round(b.stake * 100))} FM</div>
                  <div className={`bet-outcome ${b.status === 'win' ? 'win' : b.status === 'loss' ? 'loss' : 'pending'}`}>
                    {b.status === 'win' ? 'Won' : b.status === 'loss' ? 'Lost' : b.status === 'refunded' ? 'Refunded' : 'Pending'}
                    {b.result != null && <span className="bet-result">{b.result >= 0 ? ' +' : ' −'}{fmAmount(Math.round(Math.abs(b.result) * 100))} FM</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default Home;
