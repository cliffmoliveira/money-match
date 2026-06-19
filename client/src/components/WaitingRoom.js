import React, { useState } from 'react';
import './WaitingRoom.css';
import Bracket from './Bracket';
import Countdown from './Countdown';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';

// Small logo helpers that walk the asset candidates and fall back to text,
// mirroring the pattern in Home.js / LiveBetting.js.
const TournamentLogo = ({ name, height = 44 }) => {
  const [i, setI] = useState(0);
  const candidates = Object.values(getTournamentLogoSources(name)).filter(Boolean);
  const src = candidates[i];
  if (!src) return <span className="wr-tname-fallback">{name}</span>;
  return <img src={src} alt={getTournamentAlt(name)} style={getTournamentLogoStyle(name, height)}
    onError={() => setI((x) => (x + 1 < candidates.length ? x + 1 : x))} />;
};
const GameTabLogo = ({ name, height = 20 }) => {
  const [i, setI] = useState(0);
  const candidates = Object.values(getGameLogoSources(name)).filter(Boolean);
  const src = candidates[i];
  if (!src) return <>{name}</>;
  return <img src={src} alt={getGameAlt(name)} style={getGameLogoStyle(name, height)}
    onError={() => setI((x) => (x + 1 < candidates.length ? x + 1 : x))} />;
};

// Pre-Top-8 view: countdown to the tournament, per-game tabs, and the empty
// Top 8 bracket skeleton with highlighted waiting slots.
const WaitingRoom = ({ tournament, games = [] }) => {
  const [activeGame, setActiveGame] = useState(games[0]?.id ?? null);

  // The tournament date is a calendar day (UTC midnight); once it passes we
  // can't count down precisely, so show a standby status instead of a clock.
  const target = new Date(`${tournament.date}T00:00:00`).getTime();
  const started = !isNaN(target) && target <= Date.now();

  return (
    <div className="waiting-room">
      <div className="wr-header">
        <div className="wr-brand">
          <TournamentLogo name={tournament.name} />
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

      {games.length > 1 && (
        <div className="wr-game-tabs">
          {games.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`filter-tab ${g.id === activeGame ? 'active' : ''}`}
              onClick={() => setActiveGame(g.id)}
            >
              <GameTabLogo name={g.name} /> <span>{g.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="wr-bracket">
        <Bracket markets={[]} waiting />
      </div>
    </div>
  );
};

export default WaitingRoom;
