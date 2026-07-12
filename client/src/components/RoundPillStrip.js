import React, { useEffect, useRef } from 'react';
import useScrollEdges from '../utils/useScrollEdges';

// Round-pill nav (Pools, Round of N, ..., Top 8) shared by TrackerPanel
// (LiveBetting.js) and WaitingRoom.js. Horizontally scrollable with arrows
// that only show when there's actually more to scroll to, matching the
// game tab strip above it.
const RoundPillStrip = ({ rounds, selected, onSelect }) => {
  const { ref: stripRef, canScrollLeft, canScrollRight, scrollBy } = useScrollEdges([rounds.length]);
  const selectedRef = useRef(null);

  // Switching games resets `selected` to 'Top 8' (TrackerPanel), but with
  // dozens of earlier-round pills ahead of it the strip stayed scrolled
  // wherever it was — the newly-selected pill was "active" but off-screen
  // until the user manually scrolled to find it. Scroll it into view
  // whenever the selection changes, not just on manual pill clicks.
  useEffect(() => {
    // 'instant', not 'smooth': the live page re-renders this on every poll
    // cycle (new pills array reference each time), and each render re-runs
    // this effect — a smooth scroll gets cancelled and restarted by the next
    // one before it ever finishes animating, so scrollLeft never actually
    // moves. Confirmed live: 'smooth' left the strip stuck at scrollLeft 0
    // indefinitely; a plain instant jump has no animation to interrupt.
    selectedRef.current?.scrollIntoView({ behavior: 'instant', inline: 'nearest', block: 'nearest' });
  }, [selected, rounds]);

  return (
    <div className="wr-round-pills-wrap">
      {canScrollLeft && (
        <button type="button" className="wr-round-pills-arrow" aria-label="Scroll left" onClick={() => scrollBy(-1, 160)}>‹</button>
      )}
      <div className="wr-round-pills" role="tablist" ref={stripRef}>
        {rounds.map((r, i) => {
          const isSelected = selected === r.roundText;
          return (
            <button
              type="button"
              role="tab"
              key={`${r.roundText}-${i}`}
              ref={isSelected ? selectedRef : null}
              aria-selected={isSelected}
              className={`wr-round-pill wr-round-${r.status}${isSelected ? ' selected' : ''}`}
              onClick={() => onSelect(r)}
            >
              <div className="wr-round-pill-label">{r.roundText}</div>
              <div className="wr-round-pill-status">{r.status}</div>
            </button>
          );
        })}
      </div>
      {canScrollRight && (
        <button type="button" className="wr-round-pills-arrow" aria-label="Scroll right" onClick={() => scrollBy(1, 160)}>›</button>
      )}
    </div>
  );
};

export default RoundPillStrip;
