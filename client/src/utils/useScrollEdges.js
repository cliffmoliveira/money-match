import { useState, useRef, useEffect, useCallback } from 'react';

// Tracks whether a horizontally-scrollable element has more content to the
// left/right than currently fits, so a scroll-arrow affordance can show only
// when there's actually somewhere to scroll to (rather than always-on-desktop,
// always-hidden-on-mobile regardless of whether the row overflows).
export default function useScrollEdges(deps = []) {
  const ref = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    update();
    // Re-check once webfonts finish swapping in — pill/tab text can measure
    // narrower with the fallback font at mount time, understating scrollWidth
    // and leaving an arrow stuck showing (or hidden) until the next scroll/resize.
    document.fonts?.ready?.then(update);
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', update, { passive: true });
    // ResizeObserver on the element itself catches every reason its available
    // width can change (viewport resize, a sidebar/filter bar opening, a
    // parent flex item growing, ...) — a bare window "resize" listener only
    // catches the first of those.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, ...deps]);

  const scrollBy = (dir, amount) => ref.current?.scrollBy({ left: dir * amount, behavior: 'smooth' });

  return { ref, canScrollLeft, canScrollRight, scrollBy };
}
