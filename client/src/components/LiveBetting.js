import React, { useEffect, useState, useCallback } from 'react';
import './LiveBetting.css';
import Bracket from './Bracket';
import WaitingRoom from './WaitingRoom';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
// Fight Money formatters (fmt/signed kept as names so call sites are unchanged).
import { fm as fmt, fmSigned as signed, fmAmount } from '../utils/money';

const POLL_MS = 6000; // refresh markets/odds/pick'em every 6s while the Live page is open

// Game logo for the live section headers; walks the asset candidates and falls
// back to the game name as text if none load.
const GameLogo = ({ name, height = 30 }) => {
  const [index, setIndex] = useState(0);
  if (!name) return null;
  const candidates = Object.values(getGameLogoSources(name)).filter(Boolean);
  const src = candidates[index];
  if (!src) return <>{name}</>;
  return (
    <img
      src={src}
      alt={getGameAlt(name)}
      style={getGameLogoStyle(name, height)}
      onError={() => setIndex((i) => (i + 1 < candidates.length ? i + 1 : i))}
    />
  );
};

const LiveBetting = () => {
  const [markets, setMarkets] = useState([]);
  const [upcoming, setUpcoming] = useState(null);
  const [pickem, setPickem] = useState({}); // free pick'em overlay, keyed by market id
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

  const userId = localStorage.getItem('userId');

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : { demoEnabled: false }))
      .then((c) => setDemoEnabled(!!c.demoEnabled))
      .catch(() => setDemoEnabled(false));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [mRes, wRes, bRes, uRes, pRes] = await Promise.all([
        fetch('/api/live/markets'),
        fetch(`/api/wallet?userId=${userId}`),
        fetch(`/api/live/bets?userId=${userId}`),
        fetch('/api/live/upcoming'),
        fetch(`/api/pickem/overlay?userId=${userId}`),
      ]);
      if (mRes.ok) setMarkets(await mRes.json());
      if (wRes.ok) setBalanceCents((await wRes.json()).balanceCents);
      if (bRes.ok) setMyBets(await bRes.json());
      if (uRes.ok) setUpcoming(await uRes.json());
      if (pRes.ok) setPickem(await pRes.json());
      setError(null);
    } catch (err) {
      setError('Failed to load live markets.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Free pick'em: place/edit a winner pick (no money), then refresh the overlay.
  const makePick = async (marketId, playerId) => {
    if (!userId) return;
    try {
      const res = await fetch('/api/pickem/pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: Number(userId), marketId, pickedPlayerId: playerId }),
      });
      if (res.ok) refresh();
    } catch { /* ignore transient errors */ }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const addToSlip = (market, playerId) => {
    if (market.state !== 'open') return;
    const key = `${market.id}_${playerId}`;
    const isP1 = playerId === market.player1_id;
    setSlip((prev) => {
      if (prev[key]) return prev;
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
    setSlipOpen(true); // surface the slip drawer the moment a pick is added
  };

  const removeFromSlip = (key) => {
    setSlip((prev) => { const next = { ...prev }; delete next[key]; return next; });
  };

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
        const res = await fetch('/api/live/bets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: Number(userId),
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
                    <input
                      type="number" min="0" placeholder="Stake"
                      value={e.stake}
                      onChange={(ev) => updateStake(key, ev.target.value)}
                    />
                    <span className="live-slip-payout">→ {fmAmount(Math.round((Number(e.stake) || 0) * e.odds * 100))} FM</span>
                    <button type="button" className="live-slip-remove" aria-label="Remove" onClick={() => removeFromSlip(key)}>×</button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="live-slip-totals">
              <div><span>Stake</span><strong>{fmAmount(Math.round(totalStake * 100))} FM</strong></div>
              <div><span>Projected payout</span><strong>{fmAmount(Math.round(totalPayout * 100))} FM</strong></div>
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

  // Group markets by tournament -> game
  const groups = {};
  for (const m of markets) {
    const tKey = m.tournament_name;
    const gKey = m.game_name;
    groups[tKey] = groups[tKey] || {};
    groups[tKey][gKey] = groups[tKey][gKey] || [];
    groups[tKey][gKey].push(m);
  }

  return (
    <div className="live-layout">
      <div className="live-main">
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
          Object.entries(groups).map(([tournamentName, games]) => (
            <section key={tournamentName} className="live-tournament">
              <h2>{tournamentName}</h2>
              {Object.entries(games).map(([gameName, mkts]) => (
                <div key={gameName} className="live-game">
                  <h3 className="live-game-title"><GameLogo name={gameName} height={30} /><span>{gameName}</span></h3>
                  <Bracket
                    markets={mkts}
                    slip={slip}
                    onPick={addToSlip}
                    demoControls={demo ? renderDemoControls : null}
                    pickem={pickem}
                    onPickem={makePick}
                  />
                </div>
              ))}
            </section>
          ))
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
          {slipOpen && <div className="live-drawer-scrim" onClick={() => setSlipOpen(false)} />}
          <div className={`live-drawer${slipOpen ? ' open' : ''}`}>
            <button
              type="button"
              className="live-drawer-close"
              onClick={() => setSlipOpen(false)}
              aria-label="Close bet slip"
            >
              ‹ Close
            </button>
            {renderSlip()}
            {renderMyBets()}
          </div>
        </>
      )}
    </div>
  );
};

export default LiveBetting;
