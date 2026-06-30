import React, { useEffect, useState, useCallback, useRef } from 'react';
import './LiveBetting.css';
import Bracket from './Bracket';
import WaitingRoom from './WaitingRoom';
import Countdown from './Countdown';
import StakeStepper from './StakeStepper';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
// Fight Money formatters (fmt/signed kept as names so call sites are unchanged).
import { fm as fmt, fmSigned as signed, fmAmount } from '../utils/money';
import { apiFetch } from '../utils/api';
import TournamentFilterBar from './TournamentFilterBar';

const POLL_MS = 6000; // refresh markets/odds/pick'em every 6s while the Live page is open

// Game logo for the live section headers; walks the asset candidates and falls
// back to the game name as text if none load.
const GameLogo = ({ name, height = 30 }) => {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  if (!name) return null;
  const candidates = Object.values(getGameLogoSources(name)).filter(Boolean);
  const src = candidates[index];
  // Fall back to the game name as text if there's no logo, or every candidate
  // fails to load.
  if (failed || !src) return <>{name}</>;
  return (
    <img
      src={src}
      alt={getGameAlt(name)}
      style={getGameLogoStyle(name, height)}
      onError={() => (index + 1 < candidates.length ? setIndex(index + 1) : setFailed(true))}
    />
  );
};

const LiveBetting = () => {
  const [markets, setMarkets] = useState([]);
  const [pastMarkets, setPastMarkets] = useState([]);
  const [pastFilter, setPastFilter] = useState({ year: 'all', tournament: 'all', game: 'all' });
  const [pastVisible, setPastVisible] = useState(12);
  const [upcoming, setUpcoming] = useState([]);
  const [futureVisible, setFutureVisible] = useState(5);
  const [balanceCents, setBalanceCents] = useState(null);
  const [slip, setSlip] = useState({}); // key: `${marketId}_${playerId}`
  const [placing, setPlacing] = useState(false);
  const [placeMsg, setPlaceMsg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [demo, setDemo] = useState(false);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [myBets, setMyBets] = useState([]);
  const [slipOpen, setSlipOpen] = useState(false); // desktop bet-slip drawer
  const [activeTabs, setActiveTabs] = useState({});     // { [tName]: tabKey }
  const [expandedTourneys, setExpandedTourneys] = useState(new Set());
  const [showPnl, setShowPnl] = useState(false);
  const tabsRefs = useRef({});
  const scrollTabs = (tName, dir) => tabsRefs.current[tName]?.scrollBy({ left: dir * 220, behavior: 'smooth' });
  const toggleTourney = (tName) => setExpandedTourneys((prev) => {
    const next = new Set(prev);
    next.has(tName) ? next.delete(tName) : next.add(tName);
    return next;
  });

  const userId = localStorage.getItem('userId');

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : { demoEnabled: false }))
      .then((c) => setDemoEnabled(!!c.demoEnabled))
      .catch(() => setDemoEnabled(false));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [mRes, wRes, bRes, uRes, pmRes] = await Promise.all([
        fetch('/api/live/markets'),
        apiFetch(`/api/wallet?userId=${userId}`),
        apiFetch(`/api/live/bets?userId=${userId}`),
        fetch('/api/live/upcoming'),
        fetch('/api/live/past-markets'),
      ]);
      if (mRes.ok) setMarkets(await mRes.json());
      if (wRes.ok) setBalanceCents((await wRes.json()).balanceCents);
      if (bRes.ok) setMyBets(await bRes.json());
      if (uRes.ok) { const u = await uRes.json(); setUpcoming(Array.isArray(u) ? u : []); }
      if (pmRes.ok) setPastMarkets(await pmRes.json());
      setError(null);
    } catch (err) {
      setError('Failed to load live markets.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Auto-expand on first load: live tournaments first, else all, else upcoming
  const hasAutoExpanded = useRef(false);
  useEffect(() => {
    if (hasAutoExpanded.current) return;
    if (markets.length > 0) {
      hasAutoExpanded.current = true;
      const liveNames = new Set(markets.filter((m) => m.state === 'closed').map((m) => m.tournament_name));
      setExpandedTourneys(liveNames.size > 0 ? liveNames : new Set(markets.map((m) => m.tournament_name)));
    } else if (upcoming.length > 0) {
      hasAutoExpanded.current = true;
      setExpandedTourneys(new Set([upcoming[0].tournament.name]));
    }
  }, [markets, upcoming]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Tap a player to add them to the slip; tap the same player again to remove
  // them. Toggling means deselecting always clears the highlight.
  const togglePick = (market, playerId) => {
    if (market.state !== 'open') return;
    const key = `${market.id}_${playerId}`;
    const removing = Boolean(slip[key]);
    setSlip((prev) => {
      if (prev[key]) { const next = { ...prev }; delete next[key]; return next; }
      const isP1 = playerId === market.player1_id;
      return {
        ...prev,
        [key]: {
          marketId: market.id,
          playerId,
          pickName: isP1 ? market.player1_name : market.player2_name,
          oppName: isP1 ? market.player2_name : market.player1_name,
          odds: isP1 ? market.p1_live_odds : market.p2_live_odds,
          pickPoolCents: (isP1 ? market.p1_pool_cents : market.p2_pool_cents) || 0,
          oppPoolCents: (isP1 ? market.p2_pool_cents : market.p1_pool_cents) || 0,
          roundText: market.round_text,
          gameName: market.game_name,
          stake: '',
        },
      };
    });
    setPlaceMsg(null);
    if (!removing) setSlipOpen(true); // surface the slip only when adding a pick
  };

  const removeFromSlip = (key) => {
    setSlip((prev) => { const next = { ...prev }; delete next[key]; return next; });
  };

  const closeSlip = () => { setSlipOpen(false); setSlip({}); setPlaceMsg(null); };

  const updateStake = (key, value) => {
    const clean = value.replace(/[^0-9.]/g, '');
    setSlip((prev) => ({ ...prev, [key]: { ...prev[key], stake: clean } }));
  };

  const placeBets = async () => {
    const entries = Object.values(slip).filter((e) => Number(e.stake) > 0);
    if (entries.length === 0) return;
    setPlacing(true);
    setPlaceMsg(null);
    try {
      for (const e of entries) {
        const res = await apiFetch('/api/live/bets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marketId: e.marketId,
            playerId: e.playerId,
            amountCents: Math.round(Number(e.stake) * 100),
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || res.statusText);
        }
      }
      setSlip({});
      setPlaceMsg(`Placed ${entries.length} bet${entries.length > 1 ? 's' : ''}.`);
      await refresh();
    } catch (err) {
      setPlaceMsg(`Could not place bets: ${err.message}`);
    } finally {
      setPlacing(false);
    }
  };

  // Demo tools: seed markets and simulate set outcomes (dev convenience).
  const demoAction = async (path, body) => {
    try {
      await fetch(path, body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'POST' });
      await refresh();
    } catch { /* ignore */ }
  };

  // Per-node demo controls rendered inside each bracket node.
  const renderDemoControls = (m) => {
    // Only open/closed sets can be started/settled; pending (half-filled) and
    // already-resolved sets get no controls.
    if (m.state !== 'open' && m.state !== 'closed') return null;
    return (
      <div className="bnode-demo">
        {m.state === 'open' && (
          <button type="button" onClick={() => demoAction('/api/live/demo/close', { marketId: m.id })}>Start set</button>
        )}
        <button type="button" onClick={() => demoAction('/api/live/demo/settle', { marketId: m.id, winnerId: m.player1_id })}>Win {m.player1_name}</button>
        <button type="button" onClick={() => demoAction('/api/live/demo/settle', { marketId: m.id, winnerId: m.player2_id })}>Win {m.player2_name}</button>
      </div>
    );
  };

  // Slip rendered as a function (not a component) so stake inputs keep focus.
  const renderSlip = () => {
    const entries = Object.entries(slip);
    const totalStake = entries.reduce((s, [, e]) => s + (Number(e.stake) || 0), 0);
    const totalPayout = entries.reduce((s, [, e]) => s + (Number(e.stake) || 0) * e.odds, 0);
    const totalStakeCents = Math.round(totalStake * 100);
    const overBalance = balanceCents != null && totalStakeCents > balanceCents;

    return (
      <aside className="live-slip">
        <div className="live-slip-header">
          <span>Live Slip ({entries.length})</span>
          {balanceCents != null && <span className="live-slip-balance">{fmt(balanceCents)}</span>}
        </div>
        {entries.length === 0 ? (
          <p className="live-slip-empty">Tap a player's odds to add a pick.</p>
        ) : (
          <>
            <ul className="live-slip-list">
              {entries.map(([key, e]) => (
                <li key={key} className="live-slip-item">
                  <div className="live-slip-info">
                    <span className="live-slip-pick">{e.pickName} <span className="live-slip-odds">@{e.odds.toFixed(2)}</span></span>
                    <span className="live-slip-meta">vs {e.oppName} · {e.gameName}{e.roundText ? ` · ${e.roundText}` : ''}</span>
                    <span className="live-slip-pool">pool: {fmt(e.pickPoolCents)} on {e.pickName} · {fmt(e.oppPoolCents)} on {e.oppName}</span>
                  </div>
                  <div className="live-slip-stake">
                    <StakeStepper value={e.stake} onChange={(v) => updateStake(key, v)} />
                    <span className="live-slip-payout">→ {fmAmount(Math.round((Number(e.stake) || 0) * e.odds * 100))} FM</span>
                    <button type="button" className="live-slip-remove" aria-label="Remove" onClick={() => removeFromSlip(key)}>×</button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="live-slip-totals">
              <div><span>Stake</span><strong>{fmAmount(Math.round(totalStake * 100))} FM</strong></div>
              <div><span>Total payout</span><strong>{fmAmount(Math.round(totalPayout * 100))} FM</strong></div>
            </div>
            <p className="live-slip-explainer">
              <strong>Parimutuel odds.</strong> The line moves as bets come in, so this
              payout is a projection at the current odds — your actual payout is finalized
              from the pool when the set starts. Winners are always paid at least their
              share of the pool, and every payout is fully covered, so your bet is always honored.
            </p>
            {overBalance && <p className="live-slip-warn">Stake exceeds your balance.</p>}
            <button
              type="button"
              className="live-slip-place"
              disabled={placing || totalStake <= 0 || overBalance}
              onClick={placeBets}
            >
              {placing ? 'Placing…' : 'Place Bets'}
            </button>
          </>
        )}
        {placeMsg && <p className="live-slip-msg">{placeMsg}</p>}
      </aside>
    );
  };

  const STATUS = {
    placed: { label: 'PENDING', cls: 'pending' },
    won: { label: 'WON', cls: 'won' },
    lost: { label: 'LOST', cls: 'lost' },
    refunded: { label: 'REFUNDED', cls: 'refunded' },
  };

  // Placed live bets with their outcome — distinct from the staging slip above.
  const renderMyBets = () => {
    if (!myBets.length) return null;
    return (
      <aside className="live-mybets">
        <div className="live-mybets-header">My Bets ({myBets.length})</div>
        <ul className="live-mybets-list">
          {myBets.map((b) => {
            const st = STATUS[b.state] || STATUS.placed;
            const opp = b.picked_name === b.player1_name ? b.player2_name : b.player1_name;
            return (
              <li key={b.id} className="live-mybets-item">
                <div className="live-mybets-info">
                  <span className="live-mybets-pick">
                    {b.picked_name} <span className="live-mybets-odds">@{Number(b.locked_odds).toFixed(2)}</span>
                  </span>
                  <span className="live-mybets-meta">vs {opp} · {b.round_text || b.game_name}</span>
                </div>
                <div className="live-mybets-right">
                  <span className={`live-mybets-status ${st.cls}`}>{st.label}</span>
                  <span className="live-mybets-amount">
                    {b.state === 'won'
                      ? signed(b.payout_cents - b.amount_cents)
                      : b.state === 'lost'
                      ? `−${fmt(b.amount_cents)}`
                      : fmt(b.amount_cents)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>
    );
  };

  if (loading) return <p className="live-loading">Loading live markets…</p>;

  // Group markets by tournament -> game, capturing the tournament logo on first encounter
  const renderPills = (grps) => Object.entries(grps).map(([tName, { logoUrl: tLogo, date: tDate, city: tCity, country: tCountry, games }]) => {
    const tTabs = Object.entries(games)
      .sort(([, a], [, b]) => gamePriority(a) - gamePriority(b))
      .map(([gName, mkts]) => {
        const isSettled = mkts.length > 0 && mkts.every((m) => m.state === 'settled' || m.state === 'void');
        const gfMarket = isSettled ? mkts.find((m) => m.state === 'settled' && /grand.final/i.test(m.round_text || '')) : null;
        const winner = gfMarket ? shortTag(gfMarket.winner_id === gfMarket.player1_id ? gfMarket.player1_name : gfMarket.player2_name) : null;
        return { key: `${tName}::${gName}`, gameName: gName, mkts, isLive: mkts.some((m) => m.state === 'closed'), isSettled, winner };
      });
    const hasLive = tTabs.some((t) => t.isLive);
    const isExpanded = expandedTourneys.has(tName);
    const activeTabKey = (activeTabs[tName] && tTabs.find((t) => t.key === activeTabs[tName]))
      ? activeTabs[tName] : tTabs[0]?.key ?? null;
    const activeTabData = tTabs.find((t) => t.key === activeTabKey);
    const tournBets = myBets.filter((b) => b.tournament_name === tName);

    return (
      <div key={tName} className={`live-tourney-pill${hasLive ? ' has-live' : ''}`}>
        <div className="live-tourney-pill-header">
          <button type="button" className="live-tourney-pill-expand" onClick={() => toggleTourney(tName)} aria-expanded={isExpanded}>
            {tLogo && <img src={tLogo} alt={tName} className="live-tourn-header-logo" />}
            <span className="live-tourn-header-name">{tName}</span>
            {hasLive && (
              <span className="live-tourn-live-badge">
                <span className="live-tab-live-dot" aria-hidden="true" />
                LIVE
              </span>
            )}
            {tDate && (
              <span className="live-tourn-header-meta-right">
                <span className="live-tourn-header-date">
                  {new Date(`${tDate}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                </span>
                {(tCity || tCountry) && (
                  <span className="live-tourn-header-location">{[tCity, tCountry].filter(Boolean).join(', ')}</span>
                )}
              </span>
            )}
            <span className="live-tourney-chevron">{isExpanded ? '▲' : '▼'}</span>
          </button>
          {tournBets.length > 0 && (
            <button className={`live-pnl-toggle${showPnl ? ' active' : ''}`} type="button" onClick={() => setShowPnl((v) => !v)}>
              My bets
            </button>
          )}
        </div>
        {isExpanded && (
          <div className="live-tourney-pill-body">
            <div className="live-tabs-wrap">
              <button type="button" className="live-tabs-arrow" aria-label="Scroll left" onClick={() => scrollTabs(tName, -1)}>‹</button>
              <div className="live-tabs" role="tablist" ref={(el) => { tabsRefs.current[tName] = el; }}>
                {tTabs.map((tab) => (
                  <button key={tab.key} type="button" role="tab" aria-selected={tab.key === activeTabKey}
                    className={`live-tab${tab.key === activeTabKey ? ' active' : ''}${tab.isSettled ? ' settled' : ''}`}
                    onClick={() => setActiveTabs((prev) => ({ ...prev, [tName]: tab.key }))}>
                    {tab.isLive && (
                      <span className="live-tab-live-badge"><span className="live-tab-live-dot" aria-hidden="true" />LIVE</span>
                    )}
                    <div className="live-tab-logo"><GameLogo name={tab.gameName} height={32} /></div>
                    {tab.isSettled && tab.winner && (
                      <span className="live-tab-winner"><span className="live-tab-winner-star">★</span> {tab.winner}</span>
                    )}
                  </button>
                ))}
              </div>
              <button type="button" className="live-tabs-arrow" aria-label="Scroll right" onClick={() => scrollTabs(tName, 1)}>›</button>
            </div>
            {activeTabData && (
              <section className="live-tournament" role="tabpanel">
                <div className="live-game">
                  <Bracket
                    markets={activeTabData.mkts}
                    slip={slip}
                    onPick={togglePick}
                    demoControls={demo ? renderDemoControls : null}
                    bets={showPnl ? Object.fromEntries(tournBets.filter((b) => b.game_name === activeTabData.gameName).map((b) => [b.market_id, b])) : {}}
                  />
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    );
  });

  const buildGroups = (mkts) => {
    const g = {};
    for (const m of mkts) {
      if (!g[m.tournament_name]) g[m.tournament_name] = {
        logoUrl: m.tournament_logo_url || null,
        date: m.tournament_date || null,
        city: m.tournament_city || null,
        country: m.tournament_country || null,
        games: {},
      };
      g[m.tournament_name].games[m.game_name] = g[m.tournament_name].games[m.game_name] || [];
      g[m.tournament_name].games[m.game_name].push(m);
    }
    return g;
  };
  const groups = buildGroups(markets);

  // Past-section filter options (derived from the raw past markets, not groups).
  const pastYears = [...new Set(pastMarkets.map((m) => (m.tournament_date || '').slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  const pastTournaments = [...new Set(pastMarkets.map((m) => m.tournament_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const pastGames = [...new Set(pastMarkets.map((m) => m.game_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  // Apply the active filter before grouping, then paginate over tournaments.
  const filteredPast = pastMarkets.filter((m) =>
    (pastFilter.year === 'all' || (m.tournament_date || '').slice(0, 4) === pastFilter.year) &&
    (pastFilter.tournament === 'all' || m.tournament_name === pastFilter.tournament) &&
    (pastFilter.game === 'all' || m.game_name === pastFilter.game));
  const pastGroups = buildGroups(filteredPast);
  const pastEntries = Object.entries(pastGroups).sort(([, a], [, b]) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
  const shownPastGroups = Object.fromEntries(pastEntries.slice(0, pastVisible));

  const renderPastSection = () => (
    <>
      <div className="brackets-section-head">
        <div className="brackets-section-label">Past Brackets</div>
        <div className="load-more-row">
          {pastEntries.length > pastVisible && (
            <button className="load-more" onClick={() => setPastVisible((n) => n + 12)}>Show more ({pastEntries.length - pastVisible} more)</button>
          )}
          {pastVisible > 0 && (
            <button className="load-more load-more--less" onClick={() => setPastVisible((n) => Math.max(0, n - 12))}>Show less</button>
          )}
        </div>
      </div>
      {renderPills(shownPastGroups)}
    </>
  );

  // Sort games: closed (set in progress) first, then open, then pending, then settled
  const STATE_PRIORITY = { closed: 0, open: 1, pending: 2, settled: 3 };
  const gamePriority = (mkts) =>
    Math.min(...mkts.map((m) => STATE_PRIORITY[m.state] ?? 4));

  const shortTag = (name) => (name && name.includes('|') ? name.split('|').pop().trim() : name);

  return (
    <div className="live-layout">
      <div className="live-main">
        <h1 className="sr-only">Brackets</h1>
        {demoEnabled && (
          <div className="live-toolbar">
            <button type="button" className="live-demo-toggle" onClick={() => setDemo((d) => !d)}>
              {demo ? 'Hide demo tools' : 'Demo tools'}
            </button>
            {demo && (
              <>
                <button type="button" className="live-demo-seed" onClick={() => demoAction('/api/live/seed-demo')}>
                  Seed demo markets
                </button>
                <button type="button" className="live-demo-reset" onClick={() => demoAction('/api/live/demo/reset')}>
                  Reset
                </button>
                <span className="live-demo-hint">Use the controls on each card to start/settle a set.</span>
              </>
            )}
          </div>
        )}
        {error && <p className="error-message">{error}</p>}

        {pastMarkets.length > 0 && (
          <TournamentFilterBar
            years={pastYears} tournaments={pastTournaments} games={pastGames}
            value={pastFilter} onChange={setPastFilter}
            onClear={() => setPastFilter({ year: 'all', tournament: 'all', game: 'all' })}
            resultsCount={pastEntries.length}
          />
        )}

        {(() => {
          const nextUp = upcoming.length > 0 ? upcoming[upcoming.length - 1] : null;
          const futureRest = upcoming.slice(0, upcoming.length - 1);
          const renderUpcomingPill = ({ tournament: t, games }, isNextUp = false) => {
            const isExpanded = expandedTourneys.has(t.name);
            return (
              <div key={t.id} className={`live-tourney-pill${isNextUp ? ' live-tourney-pill--next-up' : ''}`}>
                <div className="live-tourney-pill-header live-tourney-pill-header--upcoming">
                  <button type="button" className="live-tourney-pill-expand" onClick={() => toggleTourney(t.name)} aria-expanded={isExpanded}>
                    {t.logoUrl && <img src={t.logoUrl} alt={t.name} className="live-tourn-header-logo" />}
                    <div className="live-tourn-header-meta">
                      <span className="live-tourn-header-name">{t.name}</span>
                      <span className="live-tourn-header-sub">
                        {new Date(`${t.date}T00:00:00`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                        {(t.city || t.country) && ` · ${[t.city, t.country].filter(Boolean).join(', ')}`}
                      </span>
                    </div>
                    <div className="live-tourn-header-countdown">
                      <Countdown date={t.date} compact />
                    </div>
                    <span className="live-tourney-chevron">{isExpanded ? '▲' : '▼'}</span>
                  </button>
                </div>
                {isExpanded && (
                  <div className="live-tourney-pill-body">
                    <WaitingRoom tournament={t} games={games || []} headerless />
                  </div>
                )}
              </div>
            );
          };
          return (
            <>
              {futureRest.length > 0 && (
                <>
                  <div className="brackets-section-head">
                    <div className="brackets-section-label">Future Tournaments</div>
                    <div className="load-more-row">
                      {futureRest.length > futureVisible && (
                        <button className="load-more" onClick={() => setFutureVisible((n) => n + 5)}>
                          Show more ({futureRest.length - futureVisible} more)
                        </button>
                      )}
                      {futureVisible > 0 && (
                        <button className="load-more load-more--less" onClick={() => setFutureVisible((n) => Math.max(0, n - 5))}>Show less</button>
                      )}
                    </div>
                  </div>
                  {futureRest.slice(Math.max(0, futureRest.length - futureVisible)).map((item) => renderUpcomingPill(item))}
                </>
              )}
              {nextUp && (
                <>
                  <div className="brackets-next-up-label">Next Up</div>
                  {renderUpcomingPill(nextUp, true)}
                </>
              )}
            </>
          );
        })()}
        {markets.length === 0 && upcoming.length === 0 && (
          <div className="live-empty">
            <h2>No live markets right now</h2>
            <p>Markets open automatically when a tracked tournament reaches Top 8.</p>
          </div>
        )}
        {markets.length > 0 && renderPills(groups)}
        {pastMarkets.length > 0 && renderPastSection()}
      </div>

      {/* Bet slip lives in a collapsible drawer so the bracket always gets the
          full page width. Only present once markets are live (nothing to bet in
          the waiting state). On mobile it stacks below the bracket (see CSS). */}
      {markets.length > 0 && (
        <>
          {!slipOpen && (
            <button
              type="button"
              className="live-drawer-tab"
              onClick={() => setSlipOpen(true)}
              aria-label="Open bet slip"
            >
              Slip ({Object.keys(slip).length})
            </button>
          )}
          {slipOpen && <div className="live-drawer-scrim" onClick={closeSlip} />}
          <div className={`live-drawer${slipOpen ? ' open' : ''}`}>
            <button
              type="button"
              className="live-drawer-close"
              onClick={closeSlip}
              aria-label="Close bet slip"
            >
              ‹ Close
            </button>
            <div className="live-drawer-body">
              {renderSlip()}
              {renderMyBets()}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default LiveBetting;
