import React, { useState, useEffect, useMemo } from 'react';
import './WaitingRoom.css';
import Bracket from './Bracket';
import Countdown from './Countdown';
import GameTracker from './GameTracker';
import GameTabStrip from './GameTabStrip';
import RoundPillStrip from './RoundPillStrip';
import OutrightPanel from './OutrightPanel';
import OutrightSlipDrawer from './OutrightSlipDrawer';
import useOutrightPicks from '../utils/useOutrightPicks';
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
  const [historyRounds, setHistoryRounds] = useState([]);
  const [trackerResults, setTrackerResults] = useState([]);
  const [trackerStillAlive, setTrackerStillAlive] = useState([]);

  // Real round-by-round history for the expanded game. The backend only
  // returns rounds it actually has history for — "Outright" and "Top 8" are
  // always prepended/appended client-side (see `pills` below).
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

  const outright = useOutrightPicks(tournament?.id, activeGame);

  // tournament.date is ideally a full timestamp with the real start.gg start
  // hour; older not-yet-resynced rows may still be a bare calendar date —
  // parseTournamentDate handles both so a bare date is treated as local
  // midnight rather than UTC midnight. Once the target time passes, stop
  // counting down and show a standby status instead of a clock.
  const target = parseTournamentDate(tournament.date)?.getTime();
  const started = !isNaN(target) && target != null && target <= Date.now();

  // "Outright" is always the first pill (open for picks until the tournament
  // starts, then it reads "locked"); "Top 8" is always appended last.
  const pills = useMemo(() => [
    { roundText: 'Outright', roundInt: null, status: outright.locked ? 'locked' : 'open' },
    ...historyRounds,
    { roundText: 'Top 8', roundInt: null, status: 'next' },
  ], [historyRounds, outright.locked]);

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
            <OutrightPanel
              seedRows={outright.seedRows}
              locked={outright.locked}
              slip={outright.slip}
              myPicks={outright.myPicks}
              onPick={outright.onPick}
            />
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

          <OutrightSlipDrawer
            slipEntries={outright.slipEntries}
            slipOpen={outright.slipOpen}
            setSlipOpen={outright.setSlipOpen}
            updateStake={outright.updateStake}
            removeFromSlip={outright.removeFromSlip}
            totalStake={outright.totalStake}
            placing={outright.placing}
            placeMsg={outright.placeMsg}
            placeOutrights={outright.placeOutrights}
          />
        </>
      )}
    </div>
  );
};

export default WaitingRoom;
