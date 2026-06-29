import React, { useEffect, useState, useCallback, useRef } from 'react';
import './LiveBetting.css';
import Bracket from './Bracket';
import WaitingRoom from './WaitingRoom';
import StakeStepper from './StakeStepper';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
// Fight Money formatters (fmt/signed kept as names so call sites are unchanged).
import { fm as fmt, fmSigned as signed, fmAmount } from '../utils/money';
import { apiFetch } from '../utils/api';
import ExhibitionSection from './ExhibitionSection';

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
  const [upcoming, setUpcoming] = useState(null);
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
  const [liveExhibitions, setLiveExhibitions] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [showPnl, setShowPnl] = useState(false);
  const tabsRef = useRef(null);
  const scrollTabs = (dir) => tabsRef.current?.scrollBy({ left: dir * 220, behavior: 'smooth' });

  const userId = localStorage.getItem('userId');

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : { demoEnabled: false }))
      .then((c) => setDemoEnabled(!!c.demoEnabled))
      .catch(() => setDemoEnabled(false));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [mRes, wRes, bRes, uRes, exRes] = await Promise.all([
        fetch('/api/live/markets'),
        apiFetch(`/api/wallet?userId=${userId}`),
        apiFetch(`/api/live/bets?userId=${userId}`),
        fetch('/api/live/upcoming'),
        fetch('/api/exhibitions/live'),
      ]);
      if (mRes.ok) setMarkets(await mRes.json());
      if (wRes.ok) setBalanceCents((await wRes.json()).balanceCents);
      if (bRes.ok) setMyBets(await bRes.json());
      if (uRes.ok) setUpcoming(await uRes.json());
      if (exRes.ok) setLiveExhibitions(await exRes.json());
      setError(null);
    } catch (err) {
      setError('Failed to load live markets.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

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
  const groups = {};
  for (const m of markets) {
    const tKey = m.tournament_name;
    const gKey = m.game_name;
    if (!groups[tKey]) groups[tKey] = { logoUrl: m.tournament_logo_url || null, games: {} };
    groups[tKey].games[gKey] = groups[tKey].games[gKey] || [];
    groups[tKey].games[gKey].push(m);
  }

  // Sort games: closed (set in progress) first, then open, then pending, then settled
  const STATE_PRIORITY = { closed: 0, open: 1, pending: 2, settled: 3 };
  const gamePriority = (mkts) =>
    Math.min(...mkts.map((m) => STATE_PRIORITY[m.state] ?? 4));

  // Flat sorted tab list: one entry per (tournament, game) pair
  const shortTag = (name) => (name && name.includes('|') ? name.split('|').pop().trim() : name);
  const tabs = [];
  for (const [tName, { logoUrl: tLogo, games }] of Object.entries(groups)) {
    for (const [gName, mkts] of Object.entries(games).sort(([, a], [, b]) => gamePriority(a) - gamePriority(b))) {
      const isSettled = mkts.length > 0 && mkts.every((m) => m.state === 'settled' || m.state === 'void');
      const gfMarket = isSettled
        ? mkts.find((m) => m.state === 'settled' && /grand.final/i.test(m.round_text || ''))
        : null;
      const winner = gfMarket
        ? shortTag(gfMarket.winner_id === gfMarket.player1_id ? gfMarket.player1_name : gfMarket.player2_name)
        : null;
      tabs.push({
        key: `${tName}::${gName}`,
        tournamentName: tName,
        gameName: gName,
        mkts,
        logoUrl: tLogo,
        isLive: mkts.some((m) => m.state === 'closed'),
        isSettled,
        winner,
      });
    }
  }
  // Resolve effective tab: keep user selection if still valid, else first tab
  const effectiveTabKey = tabs.find((t) => t.key === activeTab)?.key ?? tabs[0]?.key ?? null;
  const activeTabData = tabs.find((t) => t.key === effectiveTabKey);

  return (
    <div className="live-layout">
      <div className="live-main">
        <h1 className="sr-only">Live</h1>
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

        <ExhibitionSection exhibitions={liveExhibitions} title="Exhibition Matches" />

        {markets.length === 0 ? (
          upcoming && upcoming.tournament ? (
            <WaitingRoom tournament={upcoming.tournament} games={upcoming.games} />
          ) : (
            <div className="live-empty">
              <h2>No live markets right now</h2>
              <p>Markets open automatically when a tracked tournament reaches Top 8.</p>
            </div>
          )
        ) : (
          <>
            {/* Tournament identity header */}
            {activeTabData && (
              <div className="live-tourn-header">
                {activeTabData.logoUrl && (
                  <img src={activeTabData.logoUrl} alt={activeTabData.tournamentName} className="live-tourn-header-logo" />
                )}
                <span className="live-tourn-header-name">{activeTabData.tournamentName}</span>
              </div>
            )}

            {/* Scrollable game tab strip */}
            <div className="live-tabs-wrap">
              <button type="button" className="live-tabs-arrow" aria-label="Scroll left" onClick={() => scrollTabs(-1)}>‹</button>
              <div className="live-tabs" role="tablist" ref={tabsRef}>
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={tab.key === effectiveTabKey}
                    className={`live-tab${tab.key === effectiveTabKey ? ' active' : ''}${tab.isSettled ? ' settled' : ''}`}
                    onClick={() => setActiveTab(tab.key)}
                  >
                    {tab.isLive && (
                      <span className="live-tab-live-badge">
                        <span className="live-tab-live-dot" aria-hidden="true" />
                        LIVE
                      </span>
                    )}
                    <div className="live-tab-logo">
                      <GameLogo name={tab.gameName} height={32} />
                    </div>
                    {tab.isSettled && tab.winner && (
                      <span className="live-tab-winner">{tab.winner}</span>
                    )}
                  </button>
                ))}
              </div>
              <button type="button" className="live-tabs-arrow" aria-label="Scroll right" onClick={() => scrollTabs(1)}>›</button>
            </div>

            {/* Active bracket */}
            {activeTabData && (
              <section className="live-tournament" role="tabpanel">
                <h2>
                  {activeTabData.logoUrl && (
                    <img src={activeTabData.logoUrl} alt={activeTabData.tournamentName} className="live-tournament-logo" />
                  )}
                  {activeTabData.tournamentName}
                </h2>
                {(() => {
                  const tabBets = myBets.filter(
                    (b) => b.game_name === activeTabData.gameName && b.tournament_name === activeTabData.tournamentName
                  );
                  if (!tabBets.length) return null;
                  const won = tabBets.filter((b) => b.state === 'won').reduce((s, b) => s + (b.payout_cents - b.amount_cents), 0);
                  const lost = tabBets.filter((b) => b.state === 'lost').reduce((s, b) => s + b.amount_cents, 0);
                  const pending = tabBets.filter((b) => b.state === 'placed').reduce((s, b) => s + b.amount_cents, 0);
                  return (
                    <div className="live-pnl-wrap">
                      <button className="live-pnl-toggle" type="button" onClick={() => setShowPnl((v) => !v)}>
                        My bets <span className="live-pnl-chevron">{showPnl ? '▲' : '▼'}</span>
                      </button>
                      {showPnl && (
                        <div className="live-pnl-bar">
                          {won !== 0 && (
                            <span className="live-pnl-item live-pnl-won">
                              <span className="live-pnl-label">Won</span>
                              <span className="live-pnl-value">+{fmt(won)}</span>
                            </span>
                          )}
                          {lost > 0 && (
                            <span className="live-pnl-item live-pnl-lost">
                              <span className="live-pnl-label">Lost</span>
                              <span className="live-pnl-value">−{fmt(lost)}</span>
                            </span>
                          )}
                          {pending > 0 && (
                            <span className="live-pnl-item live-pnl-pending">
                              <span className="live-pnl-label">In play</span>
                              <span className="live-pnl-value">{fmt(pending)}</span>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="live-game">
                  <div className="live-game-aside">
                    <GameLogo name={activeTabData.gameName} height={200} />
                  </div>
                  <Bracket
                    markets={activeTabData.mkts}
                    slip={slip}
                    onPick={togglePick}
                    demoControls={demo ? renderDemoControls : null}
                  />
                </div>
              </section>
            )}
          </>
        )}
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
