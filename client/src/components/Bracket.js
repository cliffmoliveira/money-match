import React, { useRef, useState, useLayoutEffect, useCallback, useMemo } from 'react';
import './Bracket.css';
import { fm, fmAmount } from '../utils/money';
import { splitPlayerName } from '../utils/playerName';

// Fixed Top 8 double-elim template. Each column has a known capacity so empty
// positions render as TBD until their set is created.
const COLUMNS = [
  { key: 'WSF', side: 'winners', label: 'Winners Semis', cap: 2 },
  { key: 'WF', side: 'winners', label: 'Winners Final', cap: 1 },
  { key: 'GF', side: 'grand', label: 'Grand Final', cap: 1 },
  { key: 'LR1', side: 'losers', label: 'Losers Round 1', cap: 2, sortDesc: true },
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

// Single-elimination support. Manually ingested brackets (e.g. the Esports
// World Cup main stage, which isn't on start.gg — see
// docs/manual-results-ingestion.md) have only winners-side rounds: positive
// round_int, no "Winners"/"Losers" in the round text. Forcing those through
// the Top 8 double-elim template piles every set into one column and renders
// TBD skeletons for a losers bracket that doesn't exist, so build the
// columns and connector edges from the data instead.
function buildSingleElim(markets) {
  const rounds = [...new Set(markets.map((m) => m.round_int))].sort((a, b) => a - b);
  const columns = rounds.map((ri, idx) => {
    const inRound = markets.filter((m) => m.round_int === ri);
    const last = idx === rounds.length - 1;
    // "GF" keeps the champion gold styling + connector midpoint logic working.
    const label = inRound[0].round_text || (last ? 'Grand Final' : `Round ${ri}`);
    return {
      key: last ? 'GF' : `SE${ri}`,
      side: last ? 'grand' : 'winners',
      label: !last && inRound.length > 1 ? `${label}s` : label,
      cap: inRound.length,
      match: (m) => m.round_int === ri,
    };
  });
  const edges = [];
  for (let c = 0; c < columns.length - 1; c++) {
    const a = columns[c];
    const b = columns[c + 1];
    for (let i = 0; i < a.cap; i++) {
      const t = Math.floor(i / 2);
      if (t < b.cap) edges.push([`${a.key}-${i}`, `${b.key}-${t}`]);
    }
  }
  return { columns, edges };
}

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

const splitName = splitPlayerName;

export const PlayerName = ({ name }) => {
  if (!name) return <span className="bnode-tag">TBD</span>;
  const { sponsor, tag } = splitName(name);
  // 2v2 team (e.g. 2XKO): no Japanese prefix but has slash → stack player names
  if (!sponsor && name.includes('/')) {
    const [p1, ...rest] = name.split('/').map((s) => s.trim());
    return (
      <>
        <span className="bnode-tag">{p1}</span>
        <span className="bnode-tag bnode-tag-p2">{rest.join(' / ')}</span>
      </>
    );
  }
  return (
    <>
      {sponsor && <span className="bnode-sponsor">{sponsor}</span>}
      <span className="bnode-tag">{tag}</span>
    </>
  );
};

// Parimutuel pool split for a live/closed set: a bar + the money wagered on each
// side, so a bettor can see exactly what drives the odds and that payouts come
// from the pool.
const PoolBar = ({ p1 = 0, p2 = 0 }) => {
  const total = p1 + p2;
  const p1Pct = total > 0 ? (p1 / total) * 100 : null;
  const usd = (c) => `${Math.round(c / 100).toLocaleString('en-US')} FM`;
  return (
    <div className="bnode-pool" title="Pool split — shows how much FM is wagered on each side. The more lopsided it is, the bigger the underdog's payout.">
      <div className="bnode-pool-bar">
        {p1Pct !== null && <span className="p1-fill" style={{ width: `${p1Pct}%` }} />}
        {p1Pct !== null && <span className="p2-fill" style={{ width: `${100 - p1Pct}%` }} />}
      </div>
      <div className="bnode-pool-amts">
        <span>{usd(p1)}</span>
        <span className="bnode-pool-mid">pool {usd(total)}</span>
        <span>{usd(p2)}</span>
      </div>
    </div>
  );
};

const Node = ({ market, slip, onPick, demoControls, registerRef, isChampionMatch, bets = {} }) => {
  const setRef = (el) => registerRef(el);
  if (!market) {
    // Pre-tournament: nothing to show yet — the real set replaces this the
    // moment the live poller fills the slot. Outright (tournament-winner)
    // picks live on their own dedicated pill, not projected into these slots.
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
  // A market can carry more than one confirmed bet — hedging both sides of
  // the same set is allowed — so this is every bet on THIS market, not just
  // one.
  const myBets = bets[market.id] || [];
  // A confirmed bet no longer lives in `slip` — that cart empties on
  // placement — so without also checking each bet's picked_player_id, the
  // picked row's highlight vanished the moment a bet actually went through,
  // leaving only the generic "PENDING $X FM x odds" bar with neither player
  // marked.
  const picked = (pid) => Boolean(slip[`${market.id}_${pid}`]) || myBets.some((b) => b.picked_player_id === pid);
  const isReset = (market.round_text || '').toLowerCase().includes('reset');

  const row = (pid, name, odds, score, isWin, isLoss) => (
    <button
      type="button"
      className={`bnode-row ${isWin ? (isChampionMatch ? 'gf-win' : 'win') : ''} ${isLoss ? 'loss' : ''} ${picked(pid) ? 'picked' : ''}`}
      disabled={!open || !name}
      onClick={() => open && name && onPick(market, pid)}
    >
      <span className={`bnode-name bnode-name-stack ${name ? '' : 'tbd'}`} title={name || undefined}><PlayerName name={name} /></span>
      {settled
        ? <span className="bnode-score">{score}</span>
        : closed
        ? <span className="bnode-score live">{score ?? '–'}</span>
        : open
        ? <span className="bnode-odds-stack" title={`${Number(odds).toFixed(2)}× odds — pick 10 FM to win ${(10 * odds).toFixed(1)} FM back. Shifts as picks come in, locks when the set starts.`}>
            <span className="bnode-odds-label">Odds</span>
            <span className="bnode-odds">{Number(odds).toFixed(2)}</span>
          </span>
        : <span className="bnode-odds muted">—</span>}
    </button>
  );

  const p1Win = settled && market.winner_id === market.player1_id;
  const p2Win = settled && market.winner_id === market.player2_id;

  // Each bet's result attaches directly under the player it was placed on,
  // instead of every result for the match piling up in one block below both
  // rows — a hedged bet on the bottom player used to render right next to
  // the top player's result with nothing tying either one to who it's for.
  const player1Bets = myBets.filter((b) => b.picked_player_id === market.player1_id);
  const player2Bets = myBets.filter((b) => b.picked_player_id === market.player2_id);
  const lastBetId = (player2Bets.length ? player2Bets : player1Bets).slice(-1)[0]?.id;

  const betResultRow = (b) => {
    const isLast = b.id === lastBetId;
    const roundedCls = isLast ? ' bnode-bet-result-last' : '';
    if (b.state === 'won') {
      return (
        <div key={b.id} className={`bnode-bet-result won${roundedCls}`}>
          <span className="bnode-bet-label won">WON</span>
          <span className="bnode-bet-value">+{fmAmount(b.payout_cents - b.amount_cents)} FM</span>
        </div>
      );
    }
    if (b.state === 'lost') {
      return (
        <div key={b.id} className={`bnode-bet-result lost${roundedCls}`}>
          <span className="bnode-bet-label lost">LOST</span>
          <span className="bnode-bet-value">−{fm(b.amount_cents)}</span>
        </div>
      );
    }
    const inPlay = market.state === 'closed';
    return (
      <div key={b.id} className={`bnode-bet-result ${inPlay ? 'inplay' : 'pending'}${roundedCls}`}>
        <span className={`bnode-bet-label ${inPlay ? 'inplay' : 'pending'}`}>{inPlay ? 'IN PLAY' : 'PENDING'}</span>
        <span className="bnode-bet-value">{fm(b.amount_cents)} × {Number(b.locked_odds).toFixed(2)}</span>
      </div>
    );
  };

  return (
    <div ref={setRef} className={`bnode ${market.state}`}>
      {(closed || pending) && (
        <div className="bnode-head">
          {closed && <span className="bnode-live"><span className="live-dot" /> LIVE</span>}
          {pending && <span className="bnode-wait">WAITING</span>}
        </div>
      )}
      {row(market.player1_id, market.player1_name, market.p1_live_odds, market.p1_score, p1Win, p2Win)}
      {market && player1Bets.map(betResultRow)}
      {row(market.player2_id, market.player2_name, market.p2_live_odds, market.p2_score, p2Win, p1Win)}
      {market && player2Bets.map(betResultRow)}
      {open && !picked(market.player1_id) && !picked(market.player2_id) && (
        <div className="bnode-bethint">Tap a player to place a pick</div>
      )}
      {demoControls && demoControls(market)}
    </div>
  );
};

const Column = ({ col, markets, slip, onPick, demoControls, registerRef, bets }) => {
  // Dynamic (single-elim) columns carry their own matcher; template columns
  // classify by round name.
  const nodes = markets
    .filter((m) => (col.match ? col.match(m) : classify(m) === col.key))
    .sort((a, b) => col.sortDesc ? b.id - a.id : a.id - b.id);
  // Render at least `cap` cells (TBD placeholders before markets exist), but more
  // if a column actually holds extra markets — notably the Grand Final + its
  // Reset, which both classify to GF and must both be shown.
  const cells = [];
  const count = Math.max(col.cap, nodes.length);
  // Gold champion highlight only belongs on the deciding match: the reset (if one
  // exists) or the sole GF (if no reset). Never on an initial GF that was reset.
  const gfHasReset = col.key === 'GF' && nodes.some((n) => (n?.round_text || '').toLowerCase().includes('reset'));
  for (let i = 0; i < count; i++) {
    const roundText = (nodes[i]?.round_text || '').toLowerCase();
    const isChampionMatch = col.key === 'GF' && (!gfHasReset || roundText.includes('reset'));
    const isResetNode = col.key === 'GF' && roundText.includes('reset');
    const nodeKey = nodes[i]?.id ?? `${col.key}-tbd-${i}`;
    const nodeEl = (
      <Node
        market={nodes[i] || null}
        slip={slip}
        onPick={onPick}
        demoControls={demoControls}
        registerRef={(el) => registerRef(`${col.key}-${i}`, el)}
        isChampionMatch={isChampionMatch}
        bets={bets}
      />
    );
    cells.push(isResetNode
      ? <div key={nodeKey} className="bnode-reset-group">{nodeEl}<div className="bnode-reset-label">Grand Final Reset</div></div>
      : <React.Fragment key={nodeKey}>{nodeEl}</React.Fragment>
    );
  }
  return (
    <div className={`bcol ${col.side}`}>
      <div className="bcol-label">{col.label}</div>
      <div className="bcol-nodes">{cells}</div>
    </div>
  );
};

const Bracket = ({ markets = [], slip = {}, onPick, demoControls, waiting = false, bets = {} }) => {
  const fitRef = useRef(null);    // available-width container (overflow hidden)
  const innerRef = useRef(null);  // natural-size, scaled to fit
  const nodeRefs = useRef({});
  const scaleRef = useRef(1);     // scale currently applied in the DOM
  const [paths, setPaths] = useState([]);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);

  // A bracket with only winners-side rounds is single-elim: render dynamic
  // columns instead of the Top 8 double-elim template.
  const singleElim = useMemo(() => {
    const eligible =
      markets.length > 0 &&
      markets.every((m) => Number(m.round_int) > 0 && !/winners|losers/i.test(m.round_text || ''));
    return eligible ? buildSingleElim(markets) : null;
  }, [markets]);

  // recompute() stays stable across renders (it's wired to a ResizeObserver),
  // so it reads the active edge list through a ref.
  const edgesRef = useRef(EDGES);
  edgesRef.current = singleElim ? singleElim.edges : EDGES;

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
        bottom: (r.bottom - innerRect.top) / cur,
        top: (r.top - innerRect.top) / cur,
        cx: (r.left + r.width / 2 - innerRect.left) / cur,
      };
    };
    const wfBox = box('WF-0'), lfBox = box('LF-0'), gfBox = box('GF-0');
    const gfMid = gfBox ? gfBox.mid : null;
    const isMobile = availW <= 820;

    const next = [];
    for (const [from, to] of edgesRef.current) {
      const a = box(from), b = box(to);
      if (!a || !b) continue;
      const bMid = to === 'GF-0' && gfMid != null ? gfMid : b.mid;
      // Long runs (e.g. into Grand Final) bend close to the target so the
      // vertical drops in the clear gap beside it, not across a column's label.
      // Short, adjacent runs bend at the midpoint for the classic bracket look.
      // On mobile (stacked layout) the target can be to the LEFT of the source
      // (e.g. Losers Final → Grand Final). In that case jog RIGHT first so the
      // line exits right → goes up → comes back left, instead of a reverse zig-zag.
      const gap = b.left - a.right;
      // WF→GF on mobile: GF is stacked below WF, so exit from the bottom
      // center of WF, drop down, then go right into GF's left edge.
      if (from === 'WF-0' && to === 'GF-0' && bMid > a.mid && isMobile) {
        next.push(`M ${a.cx} ${a.bottom} V ${bMid} H ${b.left}`);
        continue;
      }
      // LF→GF desktop: exit from LF's right side, run right to GF's center-x,
      // then go up into the bottom of the GF card.
      if (from === 'LF-0' && to === 'GF-0' && !isMobile) {
        next.push(`M ${a.right} ${a.mid} H ${b.cx} V ${b.bottom}`);
        continue;
      }
      // LF→GF on mobile: GF is above LF, so exit from the top center of LF,
      // go up to GF's mid, then right into GF's left edge. Avoids any rightward
      // overflow that would clip at the screen edge.
      if (from === 'LF-0' && to === 'GF-0' && bMid < a.mid) {
        next.push(`M ${a.cx} ${a.top} V ${bMid} H ${b.left}`);
        continue;
      }
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
  // Single-elim: every pre-final round flows left-to-right in the winners
  // area, the final takes the grand slot, and there is no losers bracket.
  const winnerCols = singleElim
    ? singleElim.columns.filter((c) => c.key !== 'GF')
    : ['WSF', 'WF'].map(colFor);
  const loserCols = singleElim ? [] : ['LR1', 'LR2', 'LSF', 'LF'].map(colFor);
  const grandCol = singleElim ? singleElim.columns.find((c) => c.key === 'GF') : colFor('GF');
  const common = { markets, slip, onPick, demoControls, registerRef, bets };

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
            {winnerCols.map((c) => <Column key={c.key} col={c} {...common} />)}
            {/* Single-elim reads left-to-right as one row, final included */}
            {singleElim && <Column col={grandCol} {...common} />}
          </div>
          {!singleElim && (
            <div className="bracket-grand">
              <Column col={grandCol} {...common} />
            </div>
          )}
          {loserCols.length > 0 && (
            <div className="bracket-losers">
              {loserCols.map((c) => <Column key={c.key} col={c} {...common} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Bracket;
