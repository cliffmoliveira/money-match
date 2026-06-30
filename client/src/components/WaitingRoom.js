import React, { useState, useEffect, useMemo } from 'react';
import './WaitingRoom.css';
import Bracket from './Bracket';
import Countdown from './Countdown';
import StakeStepper from './StakeStepper';
import { apiFetch } from '../utils/api';
import { fmAmount } from '../utils/money';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';

// Small logo helpers that walk the asset candidates and fall back to text,
// mirroring the pattern in Home.js / LiveBetting.js.
const TournamentLogo = ({ name, logoUrl, height = 44 }) => {
  const [i, setI] = useState(0);
  // Curated local assets first, then the event's Start.gg logo, then a text
  // fallback — so a tournament without a bundled asset never renders broken.
  const candidates = [...Object.values(getTournamentLogoSources(name)), logoUrl].filter(Boolean);
  const src = candidates[i];
  if (!src) return <span className="wr-tname-fallback">{name}</span>;
  return <img src={src} alt={getTournamentAlt(name)} style={getTournamentLogoStyle(name, height)}
    onError={() => setI((x) => x + 1)} />;
};
const GameTabLogo = ({ name, height = 20 }) => {
  const [i, setI] = useState(0);
  const [failed, setFailed] = useState(false);
  const candidates = Object.values(getGameLogoSources(name)).filter(Boolean);
  const src = candidates[i];
  if (failed || !src) return <>{name}</>; // text fallback if no logo / all candidates fail
  return <img src={src} alt={getGameAlt(name)} style={getGameLogoStyle(name, height)}
    onError={() => (i + 1 < candidates.length ? setI(i + 1) : setFailed(true))} />;
};

// Pre-Top-8 view: countdown to the tournament, per-game tabs, and the empty
// Top 8 bracket skeleton with highlighted waiting slots.
const WaitingRoom = ({ tournament, games = [], headerless = false }) => {
  const [activeGame, setActiveGame] = useState(games[0]?.id ?? null);
  const [seeds, setSeeds] = useState([]);
  const [seedRows, setSeedRows] = useState([]);

  // Outright (tournament-winner) bet slip — SINGLES ONLY. Keyed by
  // `${projId}_${playerName}` to align with what the Bracket emits/highlights.
  const [projSlip, setProjSlip] = useState({});
  const [placing, setPlacing] = useState(false);
  const [placeMsg, setPlaceMsg] = useState(null);

  // The tournament date is a calendar day (UTC midnight); once it passes we
  // can't count down precisely, so show a standby status instead of a clock.
  const target = new Date(`${tournament.date}T00:00:00`).getTime();
  const started = !isNaN(target) && target <= Date.now();

  // Pull the top-8 Start.gg seeds for the active game (same source the Futures
  // page uses). These are *projected* finalists — shown view-only, never as
  // markets — so the empty pre-Top-8 bracket reads as real names.
  useEffect(() => {
    if (!activeGame || !tournament?.id) { setSeeds([]); setSeedRows([]); return; }
    let active = true;
    setSeeds([]);
    setSeedRows([]);
    fetch(`/api/game/${tournament.id}/${activeGame}/players`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (!active) return;
        const seeded = (Array.isArray(rows) ? rows : [])
          .filter((r) => r.seed_num != null)
          .slice(0, 8);
        // Keep the raw rows so the slip can look up player_id / live_odds by
        // player_name when staging an outright bet.
        setSeedRows(seeded);
        const top = seeded.map((r) => ({ seed: r.seed_num, name: r.player_name }));
        setSeeds(top);
      })
      .catch(() => { if (active) { setSeeds([]); setSeedRows([]); } });
    return () => { active = false; };
  }, [activeGame, tournament?.id]);

  // Place the 8 seeds into the standard Top-8 double-elim entry slots: top 4
  // seeds cross-paired in Winners Semis (1v4, 2v3), seeds 5-8 in Losers Round 1
  // (5v8, 6v7). Everything downstream stays TBD — results aren't known yet.
  const projected = useMemo(() => {
    if (seeds.length < 2) return {};
    const s = seeds;
    return {
      'WSF-0': [s[0], s[3]],
      'WSF-1': [s[1], s[2]],
      'LR1-0': [s[4], s[7]],
      'LR1-1': [s[5], s[6]],
    };
  }, [seeds]);
  const hasProjection = seeds.length >= 2;

  // --- Outright slip handlers (singles only) ---
  // Tap a projected player to stage/unstage a tournament-winner bet. gameId is
  // the active game; tournamentId is the event. Looks up player_id / live_odds
  // from the raw seed rows by player_name.
  const onProjectedPick = (projId, pl) => {
    const key = `${projId}_${pl.name}`;
    setProjSlip((prev) => {
      if (prev[key]) { const n = { ...prev }; delete n[key]; return n; } // toggle off
      const row = seedRows.find((r) => r.player_name === pl.name);
      if (!row) return prev;
      return { ...prev, [key]: { gameId: activeGame, playerId: row.player_id, playerName: pl.name, odds: Number(row.live_odds) || 0, stake: '' } };
    });
    setPlaceMsg(null);
  };
  const updateStake = (key, v) =>
    setProjSlip((p) => ({ ...p, [key]: { ...p[key], stake: String(v).replace(/[^0-9.]/g, '') } }));
  const removeFromSlip = (key) =>
    setProjSlip((p) => { const n = { ...p }; delete n[key]; return n; });

  const slipEntries = Object.entries(projSlip);
  const totalStake = slipEntries.reduce((sum, [, e]) => sum + (Number(e.stake) || 0), 0);

  const placeOutrights = async () => {
    const entries = slipEntries.filter(([, e]) => Number(e.stake) > 0);
    if (!entries.length) return;
    setPlacing(true); setPlaceMsg(null);
    try {
      for (const [, e] of entries) {
        const res = await apiFetch('/api/bets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tournamentId: tournament.id, gameId: e.gameId, playerId: e.playerId, amount: Number(e.stake) }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.statusText); }
      }
      setProjSlip({});
      setPlaceMsg(`Placed ${entries.length} outright${entries.length > 1 ? 's' : ''}.`);
      window.dispatchEvent(new Event('mm-wallet-changed'));
    } catch (err) { setPlaceMsg(`Could not place: ${err.message}`); }
    finally { setPlacing(false); }
  };

  return (
    <div className="waiting-room">
      {!headerless && (
        <div className="wr-header">
          <div className="wr-brand">
            <TournamentLogo name={tournament.name} logoUrl={tournament.logoUrl} />
            <div className="wr-title">
              <h2>{tournament.name}</h2>
              <p className="wr-sub">Top 8 bracket — markets open automatically when the bracket begins.</p>
            </div>
          </div>
          <div className="wr-clock">
            {started
              ? <div className="wr-standby">Top 8 hasn’t started yet — standing by…</div>
              : <Countdown date={tournament.date} />}
          </div>
        </div>
      )}

      {games.length > 1 && (
        <div className="wr-game-tabs">
          {games.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`filter-tab ${g.id === activeGame ? 'active' : ''}`}
              onClick={() => setActiveGame(g.id)}
              title={g.name}
              aria-label={g.name}
            >
              <GameTabLogo name={g.name} height={28} />
            </button>
          ))}
        </div>
      )}

      {hasProjection && (
        <p className="wr-proj-note">
          Projected Top 8 from Start.gg seeding — not yet decided. Live odds and free picks open when the bracket starts.
        </p>
      )}

      <div className="wr-bracket">
        <Bracket
          markets={[]}
          waiting
          projected={projected}
          onProjectedPick={onProjectedPick}
          projectedSlip={projSlip}
        />
      </div>

      {slipEntries.length > 0 && (
        <div className="wr-outright-slip">
          <div className="wr-slip-title">Outright bets</div>
          <div className="wr-slip-rows">
            {slipEntries.map(([key, e]) => {
              const payout = Math.round((Number(e.stake) || 0) * e.odds * 100);
              return (
                <div className="wr-slip-row" key={key}>
                  <div className="wr-slip-pick">
                    <span className="wr-slip-name">{e.playerName}</span>
                    <span className="wr-slip-odds">@{e.odds.toFixed(2)}</span>
                  </div>
                  <StakeStepper value={e.stake} onChange={(v) => updateStake(key, v)} />
                  <span className="wr-slip-payout">→ {fmAmount(payout)} FM</span>
                  <button
                    type="button"
                    className="wr-slip-remove"
                    aria-label={`Remove ${e.playerName}`}
                    onClick={() => removeFromSlip(key)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className="wr-slip-footer">
            <div className="wr-slip-total">
              <span className="wr-slip-total-label">Total stake</span>
              <span className="wr-slip-total-val">{fmAmount(Math.round(totalStake * 100))} FM</span>
            </div>
            <p className="wr-slip-note">Fixed odds — your stake locks the price.</p>
            <button
              type="button"
              className="wr-slip-place"
              disabled={placing || totalStake <= 0}
              onClick={placeOutrights}
            >
              {placing ? 'Placing…' : 'Place Outrights'}
            </button>
            {placeMsg && <p className="wr-slip-msg">{placeMsg}</p>}
          </div>
        </div>
      )}
    </div>
  );
};

export default WaitingRoom;
