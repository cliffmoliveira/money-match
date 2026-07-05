import React, { useRef, useState } from 'react';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';

// Game logo for tab strips; walks the asset candidates and falls back to the
// game name as text if none load.
export const GameLogo = ({ name, height = 30 }) => {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  if (!name) return null;
  const candidates = Object.values(getGameLogoSources(name)).filter(Boolean);
  const src = candidates[index];
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

// Shared game-selector for a multi-game tournament pill: a horizontal,
// scrollable tab strip with LIVE/winner badges. Used both pre-market
// (WaitingRoom) and once real Top-8 markets exist, so a tournament's game
// picker looks and behaves the same in every state — scales to many-game
// events (e.g. Evo) via horizontal scroll instead of stacking rows.
const GameTabStrip = ({ tabs, activeKey, onSelect }) => {
  const stripRef = useRef(null);
  const scroll = (dir) => stripRef.current?.scrollBy({ left: dir * 220, behavior: 'smooth' });
  return (
    <div className="live-tabs-wrap">
      <button type="button" className="live-tabs-arrow" aria-label="Scroll left" onClick={() => scroll(-1)}>‹</button>
      <div className="live-tabs" role="tablist" ref={stripRef}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === activeKey}
            className={`live-tab${tab.key === activeKey ? ' active' : ''}${tab.isSettled ? ' settled' : ''}`}
            onClick={() => onSelect(tab.key)}
          >
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
      <button type="button" className="live-tabs-arrow" aria-label="Scroll right" onClick={() => scroll(1)}>›</button>
    </div>
  );
};

export default GameTabStrip;
