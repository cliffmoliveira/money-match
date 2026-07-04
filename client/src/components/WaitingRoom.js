import React, { useState, useEffect, useMemo } from 'react';
import './WaitingRoom.css';
import Bracket from './Bracket';
import Countdown from './Countdown';
import StakeStepper from './StakeStepper';
import GameTracker from './GameTracker';
import { apiFetch } from '../utils/api';
import { fmAmount } from '../utils/money';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';
import { parseTournamentDate } from '../utils/tournamentDate';

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
  // Which game's row is expanded — accordion style (see the game-list render
  // below), replacing the old always-one-game tab strip. Only one game
  // expands at a time; the others stay visible as collapsed summary rows so
  // switching games never means navigating away and back.
  const [activeGame, setActiveGame] = useState(games[0]?.id ?? null);
  // Which sub-view the expanded game shows — "bracket" is the live Top 8
  // tree, "history" is the pre-Top-8 round-by-round tracker. The round pills
  // themselves (real round text from start.gg, e.g. "Pools"/"Winners Round
  // 2", plus an always-appended "Top 8") are the nav: tapping "Top 8" shows
  // the live bracket, tapping any earlier round shows that round's results —
  // so reaching Top 8 doesn't bury how a player got there (e.g. their Round
  // of 16 result) behind a view that no longer exists.
  const [activeView, setActiveView] = useState('bracket');
  const [selectedRound, setSelectedRound] = useState('Top 8');
  const openGame = (id) => { setActiveGame(id); setActiveView('bracket'); setSelectedRound('Top 8'); };
  const selectRound = (round) => {
    if (round.roundText === 'Top 8') { setActiveView('bracket'); setSelectedRound('Top 8'); }
    else { setActiveView('history'); setSelectedRound(round.roundText); }
  };
  const [seeds, setSeeds] = useState([]);
  const [seedRows, setSeedRows] = useState([]);
  const [trackerRounds, setTrackerRounds] = useState([]);
  const [trackerResults, setTrackerResults] = useState([]);
  const [trackerStillAlive, setTrackerStillAlive] = useState([]);

  // Real round-by-round history for the expanded game. "Top 8" is always
  // appended client-side as the final pill — the backend only returns rounds
  // it actually has history for. stillAlive is real elimination data (the
  // seed list minus anyone who's actually lost a tracked set) — distinct
  // from the plain `seeds` state below, which stays the full top-8 seed list
  // used for the projected outright-picks bracket.
  useEffect(() => {
    if (!activeGame || !tournament?.id) { setTrackerRounds([]); setTrackerResults([]); setTrackerStillAlive([]); return; }
    let active = true;
    fetch(`/api/game/${tournament.id}/${activeGame}/tracker`)
      .then((r) => (r.ok ? r.json() : { rounds: [], results: [], stillAlive: [] }))
      .then((data) => {
        if (!active) return;
        setTrackerRounds([...(data.rounds || []), { roundText: 'Top 8', roundInt: null, status: 'next' }]);
        setTrackerResults(data.results || []);
        setTrackerStillAlive(data.stillAlive || []);
      })
      .catch(() => {
        if (active) {
          setTrackerRounds([{ roundText: 'Top 8', roundInt: null, status: 'next' }]);
          setTrackerResults([]);
          setTrackerStillAlive([]);
        }
      });
    return () => { active = false; };
  }, [activeGame, tournament?.id]);

  // Outright (tournament-winner) bet slip — SINGLES ONLY. Keyed by
  // `${projId}_${playerName}` to align with what the Bracket emits/highlights.
  const [projSlip, setProjSlip] = useState({});
  const [placing, setPlacing] = useState(false);
  const [placeMsg, setPlaceMsg] = useState(null);
  // Slip renders in a bottom-sheet drawer (opened via a sticky floating tab)
  // instead of inline below the bracket, so it's reachable without scrolling
  // past the whole Top 8 skeleton. Sticky (not fixed) positioning keeps the
  // tab scoped to this card — if more than one waiting room is expanded at
  // once, each gets its own tab instead of them stacking on top of each other.
  const [slipOpen, setSlipOpen] = useState(false);

  // tournament.date is ideally a full timestamp with the real start.gg start
  // hour; older not-yet-resynced rows may still be a bare calendar date —
  // parseTournamentDate handles both so a bare date is treated as local
  // midnight rather than UTC midnight. Once the target time passes, stop
  // counting down and show a standby status instead of a clock.
  const target = parseTournamentDate(tournament.date)?.getTime();
  const started = !isNaN(target) && target != null && target <= Date.now();

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
    let added = false;
    setProjSlip((prev) => {
      if (prev[key]) { const n = { ...prev }; delete n[key]; return n; } // toggle off
      const row = seedRows.find((r) => r.player_name === pl.name);
      if (!row) return prev;
      added = true;
      return { ...prev, [key]: { gameId: activeGame, playerId: row.player_id, playerName: pl.name, odds: Number(row.live_odds) || 0, stake: '' } };
    });
    setPlaceMsg(null);
    if (added) setSlipOpen(true); // surface the slip only when adding a pick
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

      {/* Rough prototype: one row per game, accordion-style — tap a row to expand
          its detail in place, tap another to switch. The other rows stay visible
          the whole time, so switching games never means backing out to another
          screen. Each expanded game has its own Bracket / History toggle, so
          the pre-Top-8 round-by-round path (Round of 16, etc.) stays reachable
          even once the game's live Top 8 bracket is showing — it doesn't get
          replaced or lost once markets open. */}
      {games.length > 0 && (
        <div className="wr-game-list">
          {games.map((g) => {
            const isOpen = g.id === activeGame;
            return (
              <div className={`wr-game-row${isOpen ? ' open' : ''}`} key={g.id}>
                <button
                  type="button"
                  className="wr-game-row-header"
                  aria-expanded={isOpen}
                  aria-label={g.name}
                  title={g.name}
                  onClick={() => (isOpen ? setActiveGame(null) : openGame(g.id))}
                >
                  <div className="wr-game-row-logo"><GameTabLogo name={g.name} height={26} /></div>
                  <span className="wr-game-row-chevron">{isOpen ? '▲' : '▼'}</span>
                </button>

                {isOpen && (
                  <div className="wr-game-row-body">
                    <div className="wr-round-pills" role="tablist">
                      {trackerRounds.map((r) => (
                        <button
                          type="button"
                          role="tab"
                          key={r.roundText}
                          aria-selected={selectedRound === r.roundText}
                          className={`wr-round-pill wr-round-${r.status}${selectedRound === r.roundText ? ' selected' : ''}`}
                          onClick={() => selectRound(r)}
                        >
                          <div className="wr-round-pill-label">{r.roundText}</div>
                          <div className="wr-round-pill-status">{r.status}</div>
                        </button>
                      ))}
                    </div>

                    {activeView === 'bracket' ? (
                      <>
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
                          <>
                            {!slipOpen && (
                              <div className="wr-drawer-tab-row">
                                <button
                                  type="button"
                                  className="wr-drawer-tab"
                                  onClick={() => setSlipOpen(true)}
                                  aria-label="Open outright picks slip"
                                >
                                  Picks ({slipEntries.length})
                                </button>
                              </div>
                            )}
                            {slipOpen && <div className="wr-drawer-scrim" onClick={() => setSlipOpen(false)} />}
                            <div className={`wr-drawer${slipOpen ? ' open' : ''}`}>
                              <button
                                type="button"
                                className="wr-drawer-close"
                                onClick={() => setSlipOpen(false)}
                                aria-label="Close outright picks slip"
                              >
                                ‹ Close
                              </button>
                              <div className="wr-drawer-body">
                                <div className="wr-outright-slip">
                                  <div className="wr-slip-title">Outright picks</div>
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
                              </div>
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      <GameTracker
                        seeds={trackerStillAlive}
                        results={trackerResults}
                        roundLabel={selectedRound === 'Top 8' ? null : selectedRound}
                      />
                    )}
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

export default WaitingRoom;
