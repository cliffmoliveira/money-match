import React from 'react';
import useScrollEdges from '../utils/useScrollEdges';

// Round-pill nav (Pools, Round of N, ..., Top 8) shared by TrackerPanel
// (LiveBetting.js) and WaitingRoom.js. Horizontally scrollable with arrows
// that only show when there's actually more to scroll to, matching the
// game tab strip above it.
const RoundPillStrip = ({ rounds, selected, onSelect, trailingAction }) => {
  const { ref: stripRef, canScrollLeft, canScrollRight, scrollBy } = useScrollEdges([rounds.length]);
  return (
    <div className="wr-round-pills-wrap">
      {canScrollLeft && (
        <button type="button" className="wr-round-pills-arrow" aria-label="Scroll left" onClick={() => scrollBy(-1, 160)}>‹</button>
      )}
      <div className="wr-round-pills" role="tablist" ref={stripRef}>
        {rounds.map((r, i) => (
          <button
            type="button"
            role="tab"
            key={`${r.roundText}-${i}`}
            aria-selected={selected === r.roundText}
            className={`wr-round-pill wr-round-${r.status}${selected === r.roundText ? ' selected' : ''}`}
            onClick={() => onSelect(r)}
          >
            <div className="wr-round-pill-label">{r.roundText}</div>
            <div className="wr-round-pill-status">{r.status}</div>
          </button>
        ))}
      </div>
      {canScrollRight && (
        <button type="button" className="wr-round-pills-arrow" aria-label="Scroll right" onClick={() => scrollBy(1, 160)}>›</button>
      )}
      {trailingAction}
    </div>
  );
};

export default RoundPillStrip;
