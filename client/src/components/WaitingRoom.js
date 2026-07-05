import React, { useState, useEffect, useMemo } from 'react';
import './WaitingRoom.css';
import Bracket from './Bracket';
import Countdown from './Countdown';
import StakeStepper from './StakeStepper';
import GameTracker from './GameTracker';
import GameTabStrip from './GameTabStrip';
import RoundPillStrip from './RoundPillStrip';
import { apiFetch } from '../utils/api';
import { fmAmount } from '../utils/money';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { parseTournamentDate } from '../utils/tournamentDate';

// Small logo helper that walks the asset candidates and falls back to text,
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

// Pre-Top-8 view: countdown to the tournament, a game tab strip (same
// GameTabStrip used once real Top-8 markets exist, so the game picker looks
// and behaves the same whether a tournament is upcoming, live, or past), and
// the empty Top 8 bracket skeleton with highlighted waiting slots.
const WaitingRoom = ({ tournament, games = [], headerless = false }) => {
  const [activeGame, setActiveGame] = useState(games[0]?.id ?? null);
  // Which sub-view the expanded game shows — "outright" is the tournament-winner
  // picks panel (the default landing view for an upcoming tournament), "bracket"
  // is the live Top 8 tree, "history" is the pre-Top-8 round-by-round tracker.
  // The round pills themselves (a client-side "Outright" pill, real round text
  // from start.gg, e.g. "Pools"/"Winners Round 2", plus an always-appended
  // "Top 8") are the nav: tapping "Outright" shows the picks panel, tapping
  // "Top 8" shows the live bracket, tapping any earlier round shows that
  // round's results — so reaching Top 8 doesn't bury how a player got there
  // (e.g. their Round of 16 result) behind a view that no longer exists.
  const [activeView, setActiveView] = useState('outright');
  const [selectedRound, setSelectedRound] = useState('Outright');
  const openGame = (id) => { setActiveGame(id); setActiveView('outright'); setSelectedRound('Outright'); };
  const selectRound = (round) => {
    if (round.roundText === 'Outright') { setActiveView('outright'); setSelectedRound('Outright'); return; }
    if (round.roundText === 'Top 8') { setActiveView('bracket'); setSelectedRound('Top 8'); return; }
    setActiveView('history'); setSelectedRound(round.roundText);
  };
  const [seedRows, setSeedRows] = useState([]);
  const [outrightLocked, setOutrightLocked] = useState(false);
  const [historyRounds, setHistoryRounds] = useState([]);
  const [trackerResults, setTrackerResults] = useState([]);
  const [trackerStillAlive, setTrackerStillAlive] = useState([]);

  // Real round-by-round history for the expanded game. The backend only
  // returns rounds it actually has history for — "Outright" and "Top 8" are
  // always prepended/appended client-side (see `pills` below). stillAlive is
  // real elimination data (the seed list minus anyone who's actually lost a
  // tracked set) — distinct from `seedRows`, which stays the full top-8 seed
  // list used for outright picks.
  useEffect(() => {
    if (!activeGame || !tournament?.id) { setHistoryRounds([]); setTrackerResults([]); setTrackerStillAlive([]); return; }
    let active = true;
    fetch(`/api/game/${tournament.id}/${activeGame}/tracker`)
      .then((r) => (r.ok ? r.json() : { rounds: [], results: [], stillAlive: [] }))
      .then((data) => {
        if (!active) return;
        setHistoryRounds(data.rounds || []);
        setTrackerResults(data.results || []);
        setTrackerStillAlive(data.stillAlive || []);
      })
      .catch(() => {
        if (active) { setHistoryRounds([]); setTrackerResults([]); setTrackerStillAlive([]); }
      });
    return () => { active = false; };
  }, [activeGame, tournament?.id]);

  // Outright (tournament-winner) bet slip — SINGLES ONLY. Keyed by
  // `outright_${playerId}`.
  const [projSlip, setProjSlip] = useState({});
  const [placing, setPlacing] = useState(false);
  const [placeMsg, setPlaceMsg] = useState(null);
  // Slip renders in a bottom-sheet drawer (opened via a sticky floating tab)
  // instead of inline, so it's reachable without scrolling past whichever
  // view is active. Sticky (not fixed) positioning keeps the tab scoped to
  // this card — if more than one waiting room is expanded at once, each gets
  // its own tab instead of them stacking on top of each other.
  const [slipOpen, setSlipOpen] = useState(false);

  // tournament.date is ideally a full timestamp with the real start.gg start
  // hour; older not-yet-resynced rows may still be a bare calendar date —
  // parseTournamentDate handles both so a bare date is treated as local
  // midnight rather than UTC midnight. Once the target time passes, stop
  // counting down and show a standby status instead of a clock.
  const target = parseTournamentDate(tournament.date)?.getTime();
  const started = !isNaN(target) && target != null && target <= Date.now();

  // Pull the top-8 Start.gg seeds for the active game, plus whether outright
  // picks are locked (the tournament has started — same check POST /api/bets
  // enforces server-side).
  useEffect(() => {
    if (!activeGame || !tournament?.id) { setSeedRows([]); setOutrightLocked(false); return; }
    let active = true;
    setSeedRows([]);
    fetch(`/api/game/${tournament.id}/${activeGame}/players`)
      .then((r) => (r.ok ? r.json() : { locked: false, entrants: [] }))
      .then(({ locked, entrants }) => {
        if (!active) return;
        const seeded = (Array.isArray(entrants) ? entrants : [])
          .filter((r) => r.seed_num != null)
          .slice(0, 8);
        setSeedRows(seeded);
        setOutrightLocked(!!locked);
      })
      .catch(() => { if (active) { setSeedRows([]); setOutrightLocked(false); } });
    return () => { active = false; };
  }, [activeGame, tournament?.id]);

  // "Outright" is always the first pill (open for picks until the tournament
  // starts, then it reads "locked"); "Top 8" is always appended last.
  const pills = useMemo(() => [
    { roundText: 'Outright', roundInt: null, status: outrightLocked ? 'locked' : 'open' },
    ...historyRounds,
    { roundText: 'Top 8', roundInt: null, status: 'next' },
  ], [historyRounds, outrightLocked]);

  // --- Outright slip handlers (singles only) ---
  // Tap a seed row to stage/unstage a tournament-winner pick.
  const onOutrightPick = (row) => {
    const key = `outright_${row.player_id}`;
    let added = false;
    setProjSlip((prev) => {
      if (prev[key]) { const n = { ...prev }; delete n[key]; return n; } // toggle off
      added = true;
      return { ...prev, [key]: { gameId: activeGame, playerId: row.player_id, playerName: row.player_name, odds: Number(row.live_odds) || 0, stake: '' } };
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

      {/* Same GameTabStrip used once real Top-8 markets exist, so switching
          between a tournament's games looks and behaves identically whether
          it's upcoming, live, or settled. The round-pill nav below is the
          Bracket Tracker: tapping "Outright" shows tournament-winner picks,
          tapping "Top 8" shows the live bracket, tapping any earlier round
          shows that round's results — so reaching Top 8 doesn't bury how a
          player got there (e.g. their Round of 16 result) behind a view that
          no longer exists. */}
      {games.length > 0 && (
        <>
          <GameTabStrip
            tabs={games.map((g) => ({ key: g.id, gameName: g.name, isLive: false, isSettled: false, winner: null }))}
            activeKey={activeGame}
            onSelect={openGame}
          />
          <RoundPillStrip rounds={pills} selected={selectedRound} onSelect={selectRound} />

          {activeView === 'outright' && (
            <div className="wr-outright-panel">
              <p className="wr-proj-note">
                Pick who wins the whole tournament — fixed odds, locks the moment the bracket begins.
              </p>
              {outrightLocked ? (
                <p className="wr-empty">Outright picks are closed — this tournament has started.</p>
              ) : seedRows.length === 0 ? (
                <p className="wr-empty">Seeding not available yet.</p>
              ) : (
                <div className="wr-outright-rows">
                  {seedRows.map((row) => {
                    const key = `outright_${row.player_id}`;
                    const picked = Boolean(projSlip[key]);
                    return (
                      <button
                        key={row.player_id}
                        type="button"
                        className={`wr-outright-row${picked ? ' picked' : ''}`}
                        onClick={() => onOutrightPick(row)}
                      >
                        <span className="wr-outright-seed">#{row.seed_num}</span>
                        <span className="wr-outright-name">{row.player_name}</span>
                        <span className="wr-outright-odds">{Number(row.live_odds).toFixed(2)}×</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeView === 'bracket' && (
            <div className="wr-bracket">
              <Bracket markets={[]} waiting />
            </div>
          )}

          {activeView === 'history' && (
            <GameTracker
              seeds={trackerStillAlive}
              results={trackerResults}
              roundLabel={selectedRound}
            />
          )}

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
      )}
    </div>
  );
};

export default WaitingRoom;
