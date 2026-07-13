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
  //
  // Deliberately NOT Element.scrollIntoView(): it walks every scrollable
  // ancestor, not just this strip's own horizontal one — with no
  // vertically-scrollable container in between, that ancestor is the page
  // itself. The live page re-renders every tournament's TrackerPanel on
  // each ~6s poll cycle regardless of which one is on screen, so a
  // scrollIntoView call from an off-screen tournament's pill strip was
  // yanking the whole page's scroll position back to it — confirmed live,
  // reported as "the window auto-scrolls up after a few seconds" while
  // looking at a completely different tournament further down the page.
  // Only ever touch this container's own scrollLeft.
  useEffect(() => {
    const container = stripRef.current;
    const btn = selectedRef.current;
    if (!container || !btn) return;
    const containerRect = container.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    if (btnRect.left < containerRect.left) {
      container.scrollLeft -= containerRect.left - btnRect.left;
    } else if (btnRect.right > containerRect.right) {
      container.scrollLeft += btnRect.right - containerRect.right;
    }
  }, [selected, rounds, stripRef]);

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
