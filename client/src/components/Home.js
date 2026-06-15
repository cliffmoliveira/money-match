import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Home.css';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
import Countdown from './Countdown';

const fmt = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

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
  const { avif, webp, png, jpg, jpeg } = getGameLogoSources(name);
  const candidates = [avif, webp, png, jpg, jpeg].filter(Boolean);
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

  useEffect(() => {
    const fetchData = async () => {
      try {
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

        const tournaments = await tournamentsRes.json();
        const allTournamentsData = await allTournamentsRes.json();
        const past = await pastRes.json();
        const gamesData = await gamesRes.json();
        const playersData = await playersRes.json();

        setGames(gamesData);
        setPlayers(playersData);
        setAllTournaments(allTournamentsData);

        const sortedUpcoming = (tournaments || []).slice().sort(
          (a, b) => new Date(a.date) - new Date(b.date)
        );
        setUpcoming(sortedUpcoming);

        const champions = (past?.data || [])
          .slice()
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 6)
          .map(r => ({
            tournament: r.tournament,
            date: r.date,
            game: r.game,
            winner: r.winner,
            loser: r.loser,
            score: `${r.winnerRoundsWon}-${r.loserRoundsWon}`
          }));
        setRecentChampions(champions);
      } catch (err) {
        console.error('Home load error:', err.message);
        setError('Failed to load homepage. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

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
    return <div className="home-container"><div className="error-message">{error}</div></div>;
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
                <div className="spotlight-date">{new Date(t.date).toLocaleDateString()}</div>
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
                <span className="champion-date">{new Date(c.date).toLocaleDateString()}</span>
              </div>
              <div className="champion-score">{c.score} vs {c.loser}</div>
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
                  <div className="bet-amount">${b.stake.toFixed(2)}</div>
                  <div className={`bet-outcome ${b.status === 'win' ? 'win' : b.status === 'loss' ? 'loss' : 'pending'}`}>
                    {b.status === 'win' ? 'Won' : b.status === 'loss' ? 'Lost' : b.status === 'refunded' ? 'Refunded' : 'Pending'}
                    {b.result != null && <span className="bet-result">{b.result >= 0 ? ' +' : ' −'}${Math.abs(b.result).toFixed(2)}</span>}
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
