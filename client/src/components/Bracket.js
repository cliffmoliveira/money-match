import React, { useRef, useState, useLayoutEffect, useCallback } from 'react';
import './Bracket.css';

// Fixed Top 8 double-elim template. Each column has a known capacity so empty
// positions render as TBD until their set is created.
const COLUMNS = [
  { key: 'WSF', side: 'winners', label: 'Winners Semis', cap: 2 },
  { key: 'WF', side: 'winners', label: 'Winners Final', cap: 1 },
  { key: 'GF', side: 'grand', label: 'Grand Final', cap: 1 },
  { key: 'LR1', side: 'losers', label: 'Losers Round 1', cap: 2 },
  { key: 'LR2', side: 'losers', label: 'Losers Round 2', cap: 2 },
  { key: 'LSF', side: 'losers', label: 'Losers Semis', cap: 1 },
  { key: 'LF', side: 'losers', label: 'Losers Final', cap: 1 },
];

// Connector edges between template positions (`${colKey}-${index}`). Standard
// Top 8 flow: winners feed the final then GF; the losers run feeds up to GF.
const EDGES = [
  ['WSF-0', 'WF-0'], ['WSF-1', 'WF-0'],
  ['WF-0', 'GF-0'],
  ['LR1-0', 'LR2-0'], ['LR1-1', 'LR2-1'],
  ['LR2-0', 'LSF-0'], ['LR2-1', 'LSF-0'],
  ['LSF-0', 'LF-0'],
  ['LF-0', 'GF-0'],
];

// Map a market to a template column, primarily by round name (most reliable),
// falling back to the round_int sign.
function classify(market) {
  const t = (market.round_text || '').toLowerCase();
  if (t.includes('grand final')) return 'GF';
  if (t.includes('winners')) {
    if (t.includes('semi')) return 'WSF';
    if (t.includes('final')) return 'WF';
  }
  if (t.includes('losers')) {
    if (t.includes('quarter')) return 'LR2';
    if (t.includes('semi')) return 'LSF';
    if (t.includes('round 1') || t.includes('round1')) return 'LR1';
    if (t.includes('round 2')) return 'LR2';
    if (t.includes('final')) return 'LF';
  }
  if (market.round_int > 0) return 'WF';
  if (market.round_int < 0) return 'LR1';
  return 'WSF';
}

// Parimutuel pool split for a live/closed set: a bar + the money wagered on each
// side, so a bettor can see exactly what drives the odds and that payouts come
// from the pool.
const PoolBar = ({ p1 = 0, p2 = 0 }) => {
  const total = p1 + p2;
  const pct = total > 0 ? (p1 / total) * 100 : 50;
  const usd = (c) => `${Math.round(c / 100).toLocaleString('en-US')} FM`;
  return (
    <div className="bnode-pool" title="Live betting pool — odds are parimutuel and move as money comes in">
      <div className="bnode-pool-bar"><span style={{ width: `${pct}%` }} /></div>
      <div className="bnode-pool-amts">
        <span>{usd(p1)}</span>
        <span className="bnode-pool-mid">pool {usd(total)}</span>
        <span>{usd(p2)}</span>
      </div>
    </div>
  );
};

const Node = ({ market, slip, onPick, demoControls, registerRef, pickemFor, onPickem, projected }) => {
  const setRef = (el) => registerRef(el);
  if (!market) {
    // Pre-tournament: show the seed-projected matchup (view-only — never a market,
    // so no odds, no pool, no pick'em). The real set replaces it the moment the
    // live poller fills the slot, so no pick is ever scored against a projection.
    if (projected && projected.some(Boolean)) {
      return (
        <div ref={setRef} className="bnode projected">
          <div className="bnode-head">
            <span className="bnode-proj-badge">PROJECTED</span>
          </div>
          {[0, 1].map((i) => {
            const pl = projected[i];
            return (
              <div key={i} className="bnode-row projected">
                {pl
                  ? <span className="bnode-name"><span className="bnode-seed">#{pl.seed}</span>{pl.name}</span>
                  : <span className="bnode-name tbd">TBD</span>}
              </div>
            );
          })}
        </div>
      );
    }
    return (
      <div ref={setRef} className="bnode tbd">
        <div className="bnode-head">TBD</div>
        <div className="bnode-row"><span className="bnode-name">—</span></div>
        <div className="bnode-row"><span className="bnode-name">—</span></div>
      </div>
    );
  }
  const settled = market.state === 'settled';
  const open = market.state === 'open';
  const closed = market.state === 'closed';
  const pending = market.state === 'pending';
  const picked = (pid) => Boolean(slip[`${market.id}_${pid}`]);

  const row = (pid, name, odds, score, isWin, isLoss) => (
    <button
      type="button"
      className={`bnode-row ${isWin ? 'win' : ''} ${isLoss ? 'loss' : ''} ${picked(pid) ? 'picked' : ''}`}
      disabled={!open || !name}
      onClick={() => open && name && onPick(market, pid)}
    >
      <span className={`bnode-name ${name ? '' : 'tbd'}`}>{name || 'TBD'}</span>
      {settled
        ? <span className="bnode-score">{score}</span>
        : (open || closed)
        ? <span className="bnode-odds">{Number(odds).toFixed(2)}</span>
        : <span className="bnode-odds muted">—</span>}
    </button>
  );

  const p1Win = settled && market.winner_id === market.player1_id;
  const p2Win = settled && market.winner_id === market.player2_id;

  return (
    <div ref={setRef} className={`bnode ${market.state}`}>
      <div className="bnode-head">
        <span>{market.round_text || 'Top 8'}</span>
        {closed && <span className="bnode-live">LIVE</span>}
        {pending && <span className="bnode-wait">WAITING</span>}
      </div>
      {row(market.player1_id, market.player1_name, market.p1_live_odds, market.p1_score, p1Win, p2Win)}
      {row(market.player2_id, market.player2_name, market.p2_live_odds, market.p2_score, p2Win, p1Win)}
      {(open || closed) && <PoolBar p1={market.p1_pool_cents} p2={market.p2_pool_cents} />}
      {pickemFor && (open || closed || settled) && (
        <div className="bnode-pickem">
          <div className="bnode-pickem-label">{pickemFor.locked ? "Pick'em (locked)" : "Free pick'em"}</div>
          <div className="bnode-pickem-opts">
            {[[market.player1_id, market.player1_name], [market.player2_id, market.player2_name]].map(([pid, name]) => {
              const share = (pickemFor.split && (pickemFor.split[pid] ?? pickemFor.split[String(pid)])) || 0;
              const mine = pickemFor.myPick === pid;
              const won = settled && pickemFor.winnerId === pid;
              return (
                <button
                  key={pid}
                  type="button"
                  className={`bnode-pick${mine ? ' mine' : ''}${won ? ' won' : ''}`}
                  disabled={pickemFor.locked || !name || !onPickem}
                  onClick={() => onPickem && onPickem(market.id, pid)}
                  title={pickemFor.locked ? 'Picks are locked' : `Free pick: ${name || 'TBD'}`}
                >
                  <span className="bnode-pick-name">{name || 'TBD'}</span>
                  <span className="bnode-pick-share">{Math.round(share * 100)}%</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {demoControls && demoControls(market)}
    </div>
  );
};

const Column = ({ col, markets, slip, onPick, demoControls, registerRef, pickem, onPickem, projected }) => {
  const nodes = markets.filter((m) => classify(m) === col.key).sort((a, b) => a.id - b.id);
  // Render at least `cap` cells (TBD placeholders before markets exist), but more
  // if a column actually holds extra markets — notably the Grand Final + its
  // Reset, which both classify to GF and must both be shown.
  const cells = [];
  const count = Math.max(col.cap, nodes.length);
  for (let i = 0; i < count; i++) {
    cells.push(
      <Node
        key={nodes[i]?.id ?? `${col.key}-tbd-${i}`}
        market={nodes[i] || null}
        slip={slip}
        onPick={onPick}
        demoControls={demoControls}
        pickemFor={pickem ? pickem[nodes[i]?.id] : null}
        onPickem={onPickem}
        projected={projected ? projected[`${col.key}-${i}`] : null}
        registerRef={(el) => registerRef(`${col.key}-${i}`, el)}
      />
    );
  }
  return (
    <div className={`bcol ${col.side}`}>
      <div className="bcol-label">{col.label}</div>
      <div className="bcol-nodes">{cells}</div>
    </div>
  );
};

const Bracket = ({ markets = [], slip = {}, onPick, demoControls, waiting = false, pickem = {}, onPickem, projected = {} }) => {
  const fitRef = useRef(null);    // available-width container (overflow hidden)
  const innerRef = useRef(null);  // natural-size, scaled to fit
  const nodeRefs = useRef({});
  const scaleRef = useRef(1);     // scale currently applied in the DOM
  const gfOffsetRef = useRef(0);  // vertical nudge applied to Grand Final
  const [paths, setPaths] = useState([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [gfOffset, setGfOffset] = useState(0);

  const registerRef = useCallback((key, el) => {
    if (el) nodeRefs.current[key] = el;
    else delete nodeRefs.current[key];
  }, []);

  // Measure the natural bracket size, pick a scale that fits the available
  // width, and build orthogonal connector paths in natural coordinates.
  const recompute = useCallback(() => {
    const fit = fitRef.current, inner = innerRef.current;
    if (!fit || !inner) return;
    // offsetWidth/offsetHeight ignore CSS transforms -> always the natural size.
    const naturalW = inner.offsetWidth;
    const naturalH = inner.offsetHeight;
    if (!naturalW) return;
    const availW = fit.clientWidth;
    // Grow to fill the available width, capped so it never balloons.
    const MAX_SCALE = 1.35;
    const s = Math.min(MAX_SCALE, availW / naturalW);

    // getBoundingClientRect reflects the currently-applied transform, so divide
    // back by the scale in effect to recover natural coordinates.
    const cur = scaleRef.current || 1;
    const innerRect = inner.getBoundingClientRect();
    const box = (key) => {
      const el = nodeRefs.current[key];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      // Aim at the center of the two player rows, not the node's geometric
      // center — the header and (in demo mode) the control buttons would
      // otherwise pull the connection point off the players.
      const rows = el.querySelectorAll('.bnode-row');
      let midClient = r.top + r.height / 2;
      if (rows.length >= 2) {
        const first = rows[0].getBoundingClientRect();
        const last = rows[rows.length - 1].getBoundingClientRect();
        midClient = (first.top + last.bottom) / 2;
      }
      return {
        right: (r.right - innerRect.left) / cur,
        left: (r.left - innerRect.left) / cur,
        mid: (midClient - innerRect.top) / cur,
      };
    };
    // Grand Final sits in a cell spanning both bracket halves, so its center
    // doesn't naturally fall on the midpoint of its two feeders (the winners
    // half is shorter than the losers half). Nudge it onto that midpoint so the
    // two incoming lines meet symmetrically at its center.
    const wfBox = box('WF-0'), lfBox = box('LF-0'), gfBox = box('GF-0');
    let gfMid = gfBox ? gfBox.mid : null;
    if (wfBox && lfBox && gfBox) {
      const feederMid = (wfBox.mid + lfBox.mid) / 2;
      const naturalGfMid = gfBox.mid - gfOffsetRef.current;
      const desiredOffset = feederMid - naturalGfMid;
      if (Math.abs(desiredOffset - gfOffsetRef.current) > 0.5) {
        gfOffsetRef.current = desiredOffset;
        setGfOffset(desiredOffset);
      }
      gfMid = feederMid; // where GF will sit after the offset is applied
    }

    const next = [];
    for (const [from, to] of EDGES) {
      const a = box(from), b = box(to);
      if (!a || !b) continue;
      const bMid = to === 'GF-0' && gfMid != null ? gfMid : b.mid;
      // Long runs (e.g. into Grand Final) bend close to the target so the
      // vertical drops in the clear gap beside it, not across a column's label.
      // Short, adjacent runs bend at the midpoint for the classic bracket look.
      const gap = b.left - a.right;
      const xbend = gap > 40 ? b.left - 18 : a.right + gap / 2;
      next.push(`M ${a.right} ${a.mid} H ${xbend} V ${bMid} H ${b.left}`);
    }

    setPaths((prev) => (prev.length === next.length && prev.every((p, i) => p === next[i]) ? prev : next));
    setDims((prev) => (prev.w === naturalW && prev.h === naturalH ? prev : { w: naturalW, h: naturalH }));
    // Hysteresis: ignore sub-threshold scale changes so a 1-2px layout wobble
    // can't ping-pong the scale (belt-and-suspenders with scrollbar-gutter).
    const sRounded = Math.round(s * 1000) / 1000;
    if (Math.abs(scaleRef.current - sRounded) >= 0.005) {
      scaleRef.current = sRounded;
      setScale(sRounded);
    }
  }, []);

  useLayoutEffect(() => {
    recompute();
    const fit = fitRef.current;
    if (!fit || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(fit);
    return () => ro.disconnect();
  }, [recompute, markets]);

  const colFor = (key) => COLUMNS.find((c) => c.key === key);
  const winners = ['WSF', 'WF'];
  const losers = ['LR1', 'LR2', 'LSF', 'LF'];
  const common = { markets, slip, onPick, demoControls, registerRef, pickem, onPickem, projected };

  return (
    <div
      className={`bracket-fit${waiting ? ' bracket-waiting' : ''}`}
      ref={fitRef}
      style={{ height: dims.h ? dims.h * scale : undefined }}
    >
      <div
        className="bracket-scale"
        ref={innerRef}
        style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
      >
        <svg className="bracket-lines" width={dims.w} height={dims.h} aria-hidden="true">
          {paths.map((d, i) => <path key={i} d={d} />)}
        </svg>
        <div className="bracket-grid">
          <div className="bracket-winners">
            {winners.map((k) => <Column key={k} col={colFor(k)} {...common} />)}
          </div>
          <div className="bracket-grand" style={{ transform: `translateY(${gfOffset}px)` }}>
            <Column col={colFor('GF')} {...common} />
          </div>
          <div className="bracket-losers">
            {losers.map((k) => <Column key={k} col={colFor(k)} {...common} />)}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Bracket;
