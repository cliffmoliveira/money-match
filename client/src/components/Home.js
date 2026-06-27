import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Home.css';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
import Countdown from './Countdown';
import { fmAmount } from '../utils/money';
import AdjustBetSheet from './AdjustBetSheet';
import { apiFetch } from '../utils/api';
import ExhibitionSection from './ExhibitionSection';

// Hoisted to module scope so their component identity is stable across Home
// re-renders — defining them inside the parent recreates the type every render,
// remounting each logo and making the images flicker.
const TournamentLogo = ({ name, logoUrl, height = 24 }) => {
  const [index, setIndex] = useState(0);
  if (!name) return null;
  const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name);
  // Curated local assets first; fall back to the event's Start.gg logo so
  // tournaments without a bundled asset (e.g. VSFighting) still show an image
  // instead of a broken one.
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

// Parses "SPONSOR | tag" format used in start.gg player names
const LivePlayerName = ({ name }) => {
  if (!name) return <span className="lh-tag">TBD</span>;
  const i = name.indexOf('|');
  const sponsor = i === -1 ? '' : name.slice(0, i).trim();
  const tag = (i === -1 ? name : name.slice(i + 1)).trim();
  return (
    <span className="lh-name-stack">
      {sponsor && <span className="lh-sponsor">{sponsor}</span>}
      <span className="lh-tag">{tag}</span>
    </span>
  );
};

const Home = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [upcoming, setUpcoming] = useState([]);
  const [allTournaments, setAllTournaments] = useState([]);
  const [recentChampions, setRecentChampions] = useState([]);
  const [recentExhibitions, setRecentExhibitions] = useState([]);
  const [games, setGames] = useState([]);
  const [players, setPlayers] = useState([]);

  const [bets, setBets] = useState([]);
  const [betsLoading, setBetsLoading] = useState(false);
  const [adjustingBet, setAdjustingBet] = useState(null); // open bet in the adjust sheet
  const [betsReloadKey, setBetsReloadKey] = useState(0);   // bump to re-fetch bets+wallet

  // Live betting + wallet — the marquee feature, surfaced here as a hero.
  const [liveMarkets, setLiveMarkets] = useState([]);
  const [liveBets, setLiveBets] = useState([]);
  const [profile, setProfile] = useState(null);      // pick'em rank/points
  const [dailyBonus, setDailyBonus] = useState(null); // login-streak FM bonus
  const [claiming, setClaiming] = useState(false);

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
                logoUrl: r.logoUrl,
                date: r.date,
                game: r.game,
                winner: r.winner,
                loser: r.loser,
                score: `${r.winnerRoundsWon}-${r.loserRoundsWon}`,
              }))
          );
          setError(null);
          setLoading(false);
          // Exhibitions don't block the main load — fetch separately
          fetch('/api/exhibitions/results')
            .then((r) => r.ok ? r.json() : [])
            .then((data) => { if (!cancelled) setRecentExhibitions((data || []).slice(0, 3)); })
            .catch(() => {});
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
    if (!userId) { setProfile(null); setDailyBonus(null); return; }
    setBetsLoading(true);
    const load = async () => {
      try {
        const [fRes, lRes, wRes] = await Promise.all([
          apiFetch(`/api/bets?userId=${userId}`),
          apiFetch(`/api/live/bets?userId=${userId}`),
          apiFetch(`/api/wallet?userId=${userId}`),
        ]);
        if (fRes.ok) setBets(await fRes.json());
        if (lRes.ok) setLiveBets(await lRes.json());
        if (wRes.ok) setDailyBonus((await wRes.json()).dailyBonus || null);
      } catch (err) {
        console.error('Bets load error:', err.message);
      } finally {
        setBetsLoading(false);
      }
      // Pick'em rank/points (public endpoint, separate from the auth'd calls above).
      try {
        const pRes = await fetch(`/api/pickem/profile?userId=${userId}`);
        if (pRes.ok) setProfile(await pRes.json());
      } catch { /* non-fatal */ }
    };
    load();
  }, [userId, betsReloadKey]);

  // Poll live markets so the "Live Now" hero stays current.
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const mRes = await fetch('/api/live/markets');
        if (active && mRes.ok) setLiveMarkets(await mRes.json());
      } catch {
        /* non-fatal — the hero just falls back to its idle state */
      }
    };
    load();
    const id = setInterval(load, 20000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const getGameName = (id) => games.find(g => g.id === id)?.name || id;
  const getPlayerName = (id) => players.find(p => p.id === id)?.name || id;
  const getTournamentName = (id) => allTournaments.find(t => t.id === id)?.name || id;
  const getTournamentDate = (id) => allTournaments.find(t => t.id === id)?.date || null;

  const claimDaily = async () => {
    if (claiming) return;
    setClaiming(true);
    try {
      const res = await apiFetch('/api/wallet/daily-bonus', { method: 'POST' });
      if (res.ok) setDailyBonus((b) => (b ? { ...b, available: false } : b));
    } catch { /* ignore */ } finally {
      setClaiming(false);
    }
  };

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

  const liveNow = (liveMarkets || []).filter((m) => m.state === 'open' || m.state === 'closed');
  // The idle hero features the immediate next event, so the "Next Up" list below
  // skips it (when shown) to avoid surfacing the same event twice.
  const heroShowsNext = !!userId && liveNow.length === 0 && (upcoming?.length || 0) > 0;
  const spotlight = (heroShowsNext ? upcoming.slice(1) : (upcoming || [])).slice(0, 4);

  // Countdown shows only on the next big upcoming major — skip World Warrior / LCQ
  // qualifiers (matched by name). `upcoming` is date-sorted, so the first non-
  // qualifier is the next major; only that event's card renders a countdown.
  const isQualifierEvent = (name) => /world\s+warrior|\blcq\b|last\s+chance/i.test(name || '');
  const nextMajorId = (upcoming || []).find((t) => !isQualifierEvent(t.name))?.id ?? null;

  // One unified bet list: live per-set bets + futures, normalized to a common
  // shape, with unresolved (pending) bets surfaced first.
  const betStatusRank = { pending: 0, win: 1, loss: 2, refunded: 3 };
  const todayStr = new Date().toISOString().slice(0, 10);
  const yourBets = [
    ...(liveBets || []).map((b) => ({
      key: `live-${b.id}`, kind: 'Live',
      tournament: b.tournament_name, game: b.game_name, pick: b.picked_name,
      stake: (b.amount_cents || 0) / 100,
      status: b.state === 'won' ? 'win' : b.state === 'lost' ? 'loss' : b.state === 'refunded' ? 'refunded' : 'pending',
      result: b.state === 'won' ? (b.payout_cents - b.amount_cents) / 100 : b.state === 'lost' ? -(b.amount_cents / 100) : null,
      adjustable: false, // live bets settle per-set; not editable once placed
    })),
    ...(bets || []).map((b, i) => {
      const status = b.is_winner === 1 ? 'win' : b.is_winner === 0 ? 'loss' : 'pending';
      const date = getTournamentDate(b.tournament_id);
      return {
        key: `future-${b.id ?? i}`, kind: 'Futures',
        tournament: getTournamentName(b.tournament_id), game: getGameName(b.game_id), pick: getPlayerName(b.player_id),
        stake: Number(b.amount || 0),
        status,
        result: null,
        // Adjust support: ids + odds for the sheet. Editable only while the
        // futures market is open — pending and the event hasn't started yet
        // (mirrors the server's date-based lock; the API 409s as a backstop).
        tournamentId: b.tournament_id, gameId: b.game_id, playerId: b.player_id,
        lockedOdds: Number(b.locked_odds || 0),
        currentOdds: Number(b.current_odds || b.locked_odds || 0),
        adjustable: status === 'pending' && !!date && date > todayStr,
      };
    }),
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
            <p>Live, per-set betting on Evo, CEO and every major — plus futures on who takes it all. Virtual currency, real bragging rights.</p>
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
          </div>
          <div className="live-hero-sets">
            {liveNow.slice(0, 3).map((m) => (
              <div key={m.id} className="live-hero-set">
                <div className="lh-set-header">
                  <GameLogo name={m.game_name} height={36} />
                  {m.round_text && <span className="live-hero-meta">{m.round_text}</span>}
                </div>
                <div className="live-hero-match">
                  <span className="lh-player">
                    <LivePlayerName name={m.player1_name} />
                    <b className="lh-odds">{Number(m.p1_live_odds).toFixed(2)}</b>
                  </span>
                  <span className="lh-vs">vs</span>
                  <span className="lh-player">
                    <LivePlayerName name={m.player2_name} />
                    <b className="lh-odds">{Number(m.p2_live_odds).toFixed(2)}</b>
                  </span>
                </div>
              </div>
            ))}
          </div>
          <Link to="/live" className="btn live-hero-cta">Watch &amp; bet →</Link>
        </section>
      );
    }
    // Logged-in, nothing live — feature the immediate next event.
    const next = upcoming?.[0];
    if (next) {
      return (
        <section className="next-hero">
          <span className="next-hero-badge">Next up</span>
          <div className="next-hero-body">
            <TournamentLogo name={next.name} logoUrl={next.logoUrl} height={52} />
            <div className="next-hero-info">
              <h2>{next.name}</h2>
              <p className="next-hero-meta">
                {new Date(next.date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                {next.location?.city ? ` · ${next.location.city}, ${next.location.country}` : ''}
                {next.numEntrants ? ` · ${next.numEntrants.toLocaleString()} entrants` : ''}
              </p>
            </div>
          </div>
          {next.id === nextMajorId && <Countdown date={next.date} compact />}
          <div className="hero-actions">
            <Link to="/future-tournaments" className="btn primary">Browse futures</Link>
            <Link to="/live" className="btn">Live betting</Link>
          </div>
        </section>
      );
    }
    // No upcoming majors scheduled (rare) — minimal fallback.
    return (
      <section className="hero">
        <div className="hero-content">
          <h1>Welcome back.</h1>
          <p>No upcoming majors scheduled yet — check back soon.</p>
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
          <Link to="/leaderboard" className="stat-card stat-card-link">
            <div className="label">Rank</div>
            <div className="value">{profile?.rank ? `#${profile.rank.toLocaleString()}` : '—'}</div>
          </Link>
          <Link to="/leaderboard" className="stat-card stat-card-link">
            <div className="label">Points</div>
            <div className="value">{profile?.points != null ? profile.points.toLocaleString() : '—'}</div>
          </Link>
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

      {userId && dailyBonus && dailyBonus.available && (
        <button type="button" className="daily-bonus" onClick={claimDaily} disabled={claiming}>
          <span className="db-gift" aria-hidden="true">🎁</span>
          <span className="db-text"><strong>Day {dailyBonus.day} login streak</strong> — claim your free {fmAmount(dailyBonus.amountCents)} FM</span>
          <span className="db-cta">{claiming ? 'Claiming…' : 'Claim'}</span>
        </button>
      )}

      {userId && (
        <Link to="/live" className="pickem-nudge">
          <span className="pn-icon" aria-hidden="true">🎯</span>
          <span className="pn-text">Predict bracket winners — free picks earn ranked points.</span>
          <span className="pn-cta">Make picks →</span>
        </Link>
      )}

      {/* Your Bets — live per-set + futures, unified (above Next Up) */}
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
                  <div className="bet-row bet-row-top">
                    <div className="bet-tournament">
                      <TournamentLogo name={b.tournament} height={20} />
                      <span className="bet-tournament-name">{b.tournament}</span>
                    </div>
                    <span className={`bet-kind ${b.kind === 'Live' ? 'live' : ''}`}>{b.kind}</span>
                    <div className={`bet-outcome ${b.status === 'win' ? 'win' : b.status === 'loss' ? 'loss' : 'pending'}`}>
                      {b.status === 'win' ? 'Won' : b.status === 'loss' ? 'Lost' : b.status === 'refunded' ? 'Refunded' : 'Pending'}
                      {b.result != null && <span className="bet-result">{b.result >= 0 ? ' +' : ' −'}{fmAmount(Math.round(Math.abs(b.result) * 100))} FM</span>}
                    </div>
                    {b.adjustable && (
                      <button type="button" className="bet-adjust" aria-label="Adjust bet" title="Adjust bet" onClick={() => setAdjustingBet(b)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <div className="bet-row bet-row-bottom">
                    <div className="bet-game">
                      <GameLogo name={b.game} height={24} />
                    </div>
                    <div className="bet-player">{b.pick}</div>
                    <div className="bet-amount">{fmAmount(Math.round(b.stake * 100))} FM</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {adjustingBet && (
        <AdjustBetSheet
          bet={adjustingBet}
          onClose={() => setAdjustingBet(null)}
          onSaved={() => { setAdjustingBet(null); setBetsReloadKey((k) => k + 1); }}
        />
      )}

      {/* Upcoming Spotlight */}
      {spotlight && spotlight.length > 0 && (
        <section className="spotlight">
          <div className="section-header">
            <h2>{heroShowsNext ? 'More upcoming' : 'Next Up'}</h2>
            <Link to="/future-tournaments" className="link">See all</Link>
          </div>
          <div className="spotlight-grid">
            {spotlight.map(t => (
              <div key={t.id} className="spotlight-card">
                <div className="spotlight-header">
                  <h3>
                    <TournamentLogo name={t.name} logoUrl={t.logoUrl} height={44} />
                    <span style={{ marginLeft: '10px' }}>{t.name}</span>
                  </h3>
                </div>
                <div className="spotlight-date">{new Date(t.date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</div>
                {(t.location?.city || t.location?.country) && (
                  <div className="spotlight-location">
                    {[t.location?.city, t.location?.country].filter(Boolean).join(', ')}
                  </div>
                )}
                {t.numEntrants && (
                  <div className="spotlight-entrants">{t.numEntrants.toLocaleString()} entrants on Start.gg</div>
                )}
                <div className="spotlight-games">
                  {(Object.values(t.games || {}) || []).slice(0, 4).map(g => (
                    <span key={g.id} className="pill">{g.name}</span>
                  ))}
                  {Object.values(t.games || {}).length > 4 && (
                    <span className="more-pill">+{Object.values(t.games || {}).length - 4} more</span>
                  )}
                </div>
                {t.id === nextMajorId && <Countdown date={t.date} compact />}
              </div>
            ))}
          </div>
        </section>
      )}

      {recentExhibitions.length > 0 && (
        <ExhibitionSection exhibitions={recentExhibitions} title="Exhibition Results" />
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
                <span className="champion-tournament">
                  <TournamentLogo name={c.tournament} logoUrl={c.logoUrl} height={16} />
                  <span>{c.tournament}</span>
                </span>
                <span className="champion-date">{new Date(c.date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</span>
              </div>
              <div className="champion-score"><b>{c.score}</b> def. {c.loser}</div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
};

export default Home;
