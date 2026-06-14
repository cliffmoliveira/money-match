import React, { useEffect, useState, useCallback } from 'react';
import './LiveBetting.css';
import Bracket from './Bracket';

const fmt = (cents) => `$${(cents / 100).toFixed(2)}`;
const POLL_MS = 15000;

const LiveBetting = () => {
  const [markets, setMarkets] = useState([]);
  const [balanceCents, setBalanceCents] = useState(null);
  const [slip, setSlip] = useState({}); // key: `${marketId}_${playerId}`
  const [placing, setPlacing] = useState(false);
  const [placeMsg, setPlaceMsg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [demo, setDemo] = useState(false);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [myBets, setMyBets] = useState([]);

  const userId = localStorage.getItem('userId');

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : { demoEnabled: false }))
      .then((c) => setDemoEnabled(!!c.demoEnabled))
      .catch(() => setDemoEnabled(false));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [mRes, wRes, bRes] = await Promise.all([
        fetch('/api/live/markets'),
        fetch(`/api/wallet?userId=${userId}`),
        fetch(`/api/live/bets?userId=${userId}`),
      ]);
      if (mRes.ok) setMarkets(await mRes.json());
      if (wRes.ok) setBalanceCents((await wRes.json()).balanceCents);
      if (bRes.ok) setMyBets(await bRes.json());
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
                    <span className="live-slip-payout">→ ${((Number(e.stake) || 0) * e.odds).toFixed(2)}</span>
                    <button type="button" className="live-slip-remove" aria-label="Remove" onClick={() => removeFromSlip(key)}>×</button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="live-slip-totals">
              <div><span>Stake</span><strong>${totalStake.toFixed(2)}</strong></div>
              <div><span>Projected payout</span><strong>${totalPayout.toFixed(2)}</strong></div>
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
                      ? `+${fmt(b.payout_cents - b.amount_cents)}`
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
          <div className="live-empty">
            <h2>No live markets right now</h2>
            <p>Markets open automatically when a tracked tournament reaches Top 8.</p>
          </div>
        ) : (
          Object.entries(groups).map(([tournamentName, games]) => (
            <section key={tournamentName} className="live-tournament">
              <h2>{tournamentName}</h2>
              {Object.entries(games).map(([gameName, mkts]) => (
                <div key={gameName} className="live-game">
                  <h3>{gameName}</h3>
                  <Bracket
                    markets={mkts}
                    slip={slip}
                    onPick={addToSlip}
                    demoControls={demo ? renderDemoControls : null}
                  />
                </div>
              ))}
            </section>
          ))
        )}
      </div>
      <div className="live-rail">
        {renderSlip()}
        {renderMyBets()}
      </div>
    </div>
  );
};

export default LiveBetting;
