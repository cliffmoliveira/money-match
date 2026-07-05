import React, { useEffect, useState, useCallback, useRef } from 'react';
import './LiveBetting.css';
import Bracket from './Bracket';
import WaitingRoom from './WaitingRoom';
import GameTracker from './GameTracker';
import GameTabStrip from './GameTabStrip';
import RoundPillStrip from './RoundPillStrip';
import Countdown from './Countdown';
import StakeStepper from './StakeStepper';
// Fight Money formatters (fmt/signed kept as names so call sites are unchanged).
import { fm as fmt, fmSigned as signed, fmAmount } from '../utils/money';
import { apiFetch } from '../utils/api';
import TournamentFilterBar from './TournamentFilterBar';
import { formatTournamentDateTime, parseTournamentDate } from '../utils/tournamentDate';

const POLL_MS = 6000; // refresh markets/odds/pick'em every 6s while the Live page is open

// Pre-Top-8 round history (Pools, Round of N, ...) for a tournament/game that
// already has real Top-8 markets — the same round-pill nav WaitingRoom uses
// pre-Top-8, so a tournament's full run stays visible once markets exist
// (live or already settled), not just its Top 8 bracket.
const TrackerPanel = ({ tournamentId, gameId, top8Status, bracket }) => {
  const [rounds, setRounds] = useState([]);
  const [results, setResults] = useState([]);
  const [stillAlive, setStillAlive] = useState([]);
  const [selected, setSelected] = useState('Top 8');

  useEffect(() => {
    if (!tournamentId || !gameId) { setRounds([]); setResults([]); setStillAlive([]); return; }
    let active = true;
    setSelected('Top 8');
    fetch(`/api/game/${tournamentId}/${gameId}/tracker`)
      .then((r) => (r.ok ? r.json() : { rounds: [], results: [], stillAlive: [] }))
      .then((data) => {
        if (!active) return;
        setRounds(data.rounds || []);
        setResults(data.results || []);
        setStillAlive(data.stillAlive || []);
      })
      .catch(() => { if (active) { setRounds([]); setResults([]); setStillAlive([]); } });
    return () => { active = false; };
  }, [tournamentId, gameId]);

  if (rounds.length === 0) return bracket; // nothing tracked pre-Top-8 — just the bracket

  const pills = [...rounds, { roundText: 'Top 8', roundInt: null, status: top8Status }];
  return (
    <>
      <RoundPillStrip rounds={pills} selected={selected} onSelect={(r) => setSelected(r.roundText)} />
      {selected === 'Top 8'
        ? bracket
        : <GameTracker seeds={stillAlive} results={results} roundLabel={selected} />}
    </>
  );
};

const LiveBetting = () => {
  const [markets, setMarkets] = useState([]);
  const [pastMarkets, setPastMarkets] = useState([]);
  const [pastFilter, setPastFilter] = useState({ year: 'all', tournament: 'all', game: 'all' });
  const [pastVisible, setPastVisible] = useState(5);
  const [upcoming, setUpcoming] = useState([]);
  const [futureVisible, setFutureVisible] = useState(0);
  const [balanceCents, setBalanceCents] = useState(null);
  const [slip, setSlip] = useState({}); // key: `${marketId}_${playerId}`
  const [placing, setPlacing] = useState(false);
  const [placeMsg, setPlaceMsg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [demo, setDemo] = useState(false);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [myBets, setMyBets] = useState([]);
  const [slipOpen, setSlipOpen] = useState(false); // desktop bet-slip drawer
  const [activeTabs, setActiveTabs] = useState({});     // { [tName]: tabKey }
  const [expandedTourneys, setExpandedTourneys] = useState(new Set());
  const [showPnl, setShowPnl] = useState(false);
  const toggleTourney = (tName) => setExpandedTourneys((prev) => {
    const next = new Set(prev);
    next.has(tName) ? next.delete(tName) : next.add(tName);
    return next;
  });

  const userId = localStorage.getItem('userId');

  useEffect(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : { demoEnabled: false }))
      .then((c) => setDemoEnabled(!!c.demoEnabled))
      .catch(() => setDemoEnabled(false));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [mRes, wRes, bRes, uRes, pmRes] = await Promise.all([
        fetch('/api/live/markets'),
        apiFetch(`/api/wallet?userId=${userId}`),
        apiFetch(`/api/live/bets?userId=${userId}`),
        fetch('/api/live/upcoming'),
        fetch('/api/live/past-markets'),
      ]);
      if (mRes.ok) setMarkets(await mRes.json());
      if (wRes.ok) setBalanceCents((await wRes.json()).balanceCents);
      if (bRes.ok) setMyBets(await bRes.json());
      if (uRes.ok) { const u = await uRes.json(); setUpcoming(Array.isArray(u) ? u : []); }
      if (pmRes.ok) setPastMarkets(await pmRes.json());
      setError(null);
    } catch (err) {
      setError('Failed to load live markets.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Auto-expand on first load: live tournaments first, else all, else upcoming
  const hasAutoExpanded = useRef(false);
  useEffect(() => {
    if (hasAutoExpanded.current) return;
    if (markets.length > 0) {
      hasAutoExpanded.current = true;
      const liveNames = new Set(markets.filter((m) => m.state === 'closed').map((m) => m.tournament_name));
      setExpandedTourneys(liveNames.size > 0 ? liveNames : new Set(markets.map((m) => m.tournament_name)));
    } else if (upcoming.length > 0) {
      hasAutoExpanded.current = true;
      setExpandedTourneys(new Set([upcoming[0].tournament.name]));
    }
  }, [markets, upcoming]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Tap a player to add them to the slip; tap the same player again to remove
  // them. Toggling means deselecting always clears the highlight.
  const togglePick = (market, playerId) => {
    if (market.state !== 'open') return;
    const key = `${market.id}_${playerId}`;
    const removing = Boolean(slip[key]);
    setSlip((prev) => {
      if (prev[key]) { const next = { ...prev }; delete next[key]; return next; }
      const isP1 = playerId === market.player1_id;
      return {
        ...prev,
        [key]: {
          marketId: market.id,
          playerId,
          pickName: isP1 ? market.player1_name : market.player2_name,
          oppName: isP1 ? market.player2_name : market.player1_name,
          odds: isP1 ? market.p1_live_odds : market.p2_live_odds,
          pickPoolCents: (isP1 ? market.p1_pool_cents : market.p2_pool_cents) || 0,
          oppPoolCents: (isP1 ? market.p2_pool_cents : market.p1_pool_cents) || 0,
          roundText: market.round_text,
          gameName: market.game_name,
          stake: '',
        },
      };
    });
    setPlaceMsg(null);
    if (!removing) setSlipOpen(true); // surface the slip only when adding a pick
  };

  const removeFromSlip = (key) => {
    setSlip((prev) => { const next = { ...prev }; delete next[key]; return next; });
  };

  const closeSlip = () => { setSlipOpen(false); setSlip({}); setPlaceMsg(null); };

  const updateStake = (key, value) => {
    const clean = value.replace(/[^0-9.]/g, '');
    setSlip((prev) => ({ ...prev, [key]: { ...prev[key], stake: clean } }));
  };

  const placeBets = async () => {
    const entries = Object.values(slip).filter((e) => Number(e.stake) > 0);
    if (entries.length === 0) return;
    setPlacing(true);
    setPlaceMsg(null);
    try {
      for (const e of entries) {
        const res = await apiFetch('/api/live/bets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marketId: e.marketId,
            playerId: e.playerId,
            amountCents: Math.round(Number(e.stake) * 100),
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || res.statusText);
        }
      }
      setSlip({});
      setPlaceMsg(`Placed ${entries.length} pick${entries.length > 1 ? 's' : ''}.`);
      await refresh();
    } catch (err) {
      setPlaceMsg(`Could not place picks: ${err.message}`);
    } finally {
      setPlacing(false);
    }
  };

  // Demo tools: seed markets and simulate set outcomes (dev convenience).
  const demoAction = async (path, body) => {
    try {
      await fetch(path, body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'POST' });
      await refresh();
    } catch { /* ignore */ }
  };

  // Per-node demo controls rendered inside each bracket node.
  const renderDemoControls = (m) => {
    // Only open/closed sets can be started/settled; pending (half-filled) and
    // already-resolved sets get no controls.
    if (m.state !== 'open' && m.state !== 'closed') return null;
    return (
      <div className="bnode-demo">
        {m.state === 'open' && (
          <button type="button" onClick={() => demoAction('/api/live/demo/close', { marketId: m.id })}>Start set</button>
        )}
        <button type="button" onClick={() => demoAction('/api/live/demo/settle', { marketId: m.id, winnerId: m.player1_id })}>Win {m.player1_name}</button>
        <button type="button" onClick={() => demoAction('/api/live/demo/settle', { marketId: m.id, winnerId: m.player2_id })}>Win {m.player2_name}</button>
      </div>
    );
  };

  // Slip rendered as a function (not a component) so stake inputs keep focus.
  const renderSlip = () => {
    const entries = Object.entries(slip);
    const totalStake = entries.reduce((s, [, e]) => s + (Number(e.stake) || 0), 0);
    const totalPayout = entries.reduce((s, [, e]) => s + (Number(e.stake) || 0) * e.odds, 0);
    const totalStakeCents = Math.round(totalStake * 100);
    const overBalance = balanceCents != null && totalStakeCents > balanceCents;

    return (
      <aside className="live-slip">
        <div className="live-slip-header">
          <span>Live Slip ({entries.length})</span>
          {balanceCents != null && <span className="live-slip-balance">{fmt(balanceCents)}</span>}
        </div>
        {entries.length === 0 ? (
          <p className="live-slip-empty">Tap a player's odds to add a pick.</p>
        ) : (
          <>
            <ul className="live-slip-list">
              {entries.map(([key, e]) => (
                <li key={key} className="live-slip-item">
                  <div className="live-slip-info">
                    <span className="live-slip-pick">{e.pickName} <span className="live-slip-odds">@{e.odds.toFixed(2)}</span></span>
                    <span className="live-slip-meta">vs {e.oppName} · {e.gameName}{e.roundText ? ` · ${e.roundText}` : ''}</span>
                    <span className="live-slip-pool">pool: {fmt(e.pickPoolCents)} on {e.pickName} · {fmt(e.oppPoolCents)} on {e.oppName}</span>
                  </div>
                  <div className="live-slip-stake">
                    <StakeStepper value={e.stake} onChange={(v) => updateStake(key, v)} />
                    <span className="live-slip-payout">→ {fmAmount(Math.round((Number(e.stake) || 0) * e.odds * 100))} FM</span>
                    <button type="button" className="live-slip-remove" aria-label="Remove" onClick={() => removeFromSlip(key)}>×</button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="live-slip-totals">
              <div><span>Stake</span><strong>{fmAmount(Math.round(totalStake * 100))} FM</strong></div>
              <div><span>Total payout</span><strong>{fmAmount(Math.round(totalPayout * 100))} FM</strong></div>
            </div>
            <p className="live-slip-explainer">
              <strong>Parimutuel odds.</strong> The line moves as picks come in, so this
              payout is a projection at the current odds — your actual payout is finalized
              from the pool when the set starts. Winners are always paid at least their
              share of the pool, and every payout is fully covered, so your pick is always honored.
            </p>
            {overBalance && <p className="live-slip-warn">Stake exceeds your balance.</p>}
            <button
              type="button"
              className="live-slip-place"
              disabled={placing || totalStake <= 0 || overBalance}
              onClick={placeBets}
            >
              {placing ? 'Placing…' : 'Place Picks'}
            </button>
          </>
        )}
        {placeMsg && <p className="live-slip-msg">{placeMsg}</p>}
      </aside>
    );
  };

  const STATUS = {
    placed: { label: 'PENDING', cls: 'pending' },
    won: { label: 'WON', cls: 'won' },
    lost: { label: 'LOST', cls: 'lost' },
    refunded: { label: 'REFUNDED', cls: 'refunded' },
  };

  // Placed live bets with their outcome — distinct from the staging slip above.
  const renderMyBets = () => {
    if (!myBets.length) return null;
    return (
      <aside className="live-mybets">
        <div className="live-mybets-header">My Picks ({myBets.length})</div>
        <ul className="live-mybets-list">
          {myBets.map((b) => {
            const st = STATUS[b.state] || STATUS.placed;
            const opp = b.picked_name === b.player1_name ? b.player2_name : b.player1_name;
            return (
              <li key={b.id} className="live-mybets-item">
                <div className="live-mybets-info">
                  <span className="live-mybets-pick">
                    {b.picked_name} <span className="live-mybets-odds">@{Number(b.locked_odds).toFixed(2)}</span>
                  </span>
                  <span className="live-mybets-meta">vs {opp} · {b.round_text || b.game_name}</span>
                </div>
                <div className="live-mybets-right">
                  <span className={`live-mybets-status ${st.cls}`}>{st.label}</span>
                  <span className="live-mybets-amount">
                    {b.state === 'won'
                      ? signed(b.payout_cents - b.amount_cents)
                      : b.state === 'lost'
                      ? `−${fmt(b.amount_cents)}`
                      : fmt(b.amount_cents)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>
    );
  };

  if (loading) return <p className="live-loading">Loading live markets…</p>;

  // Single header layout shared by every tournament pill (Future/Next Up/Live/
  // Past/marketed) — logo, name (+ LIVE badge), date · location · entrants
  // subline, optional countdown, chevron. One consistent look regardless of
  // which section or data source (upcoming vs real markets) the pill came from.
  const renderTourneyHeader = ({ name, logoUrl, date, city, country, numEntrants, hasLive, isExpanded, onToggle, countdown }) => (
    <div className="live-tourney-pill-header live-tourney-pill-header--upcoming">
      <button type="button" className="live-tourney-pill-expand" onClick={onToggle} aria-expanded={isExpanded}>
        {logoUrl && <img src={logoUrl} alt={name} className="live-tourn-header-logo" />}
        <div className="live-tourn-header-meta">
          <span className="live-tourn-header-name-row">
            <span className="live-tourn-header-name">{name}</span>
            {hasLive && (
              <span className="live-tourn-live-badge">
                <span className="live-tourn-live-dot" aria-hidden="true" />
                LIVE
              </span>
            )}
          </span>
          <span className="live-tourn-header-sub">
            {date && formatTournamentDateTime(date)}
            {(city || country) && ` · ${[city, country].filter(Boolean).join(', ')}`}
            {numEntrants ? ` · ${numEntrants.toLocaleString()} entrants` : ''}
          </span>
        </div>
        {countdown}
        <span className="live-tourney-chevron">{isExpanded ? '▲' : '▼'}</span>
      </button>
    </div>
  );

  // Group markets by tournament -> game, capturing the tournament logo on first encounter
  const renderPills = (grps) => Object.entries(grps).map(([tName, { logoUrl: tLogo, date: tDate, city: tCity, country: tCountry, numEntrants: tNumEntrants, games }]) => {
    const tTabs = Object.entries(games)
      .sort(([, a], [, b]) => gamePriority(a) - gamePriority(b))
      .map(([gName, mkts]) => {
        const isSettled = mkts.length > 0 && mkts.every((m) => m.state === 'settled' || m.state === 'void');
        const gfMarket = isSettled ? mkts.find((m) => m.state === 'settled' && /grand.final/i.test(m.round_text || '')) : null;
        const winner = gfMarket ? shortTag(gfMarket.winner_id === gfMarket.player1_id ? gfMarket.player1_name : gfMarket.player2_name) : null;
        return { key: `${tName}::${gName}`, gameName: gName, mkts, isLive: mkts.some((m) => m.state === 'closed'), isSettled, winner };
      });
    const hasLive = tTabs.some((t) => t.isLive);
    const isExpanded = expandedTourneys.has(tName);
    const activeTabKey = (activeTabs[tName] && tTabs.find((t) => t.key === activeTabs[tName]))
      ? activeTabs[tName] : tTabs[0]?.key ?? null;
    const activeTabData = tTabs.find((t) => t.key === activeTabKey);
    const tournBets = myBets.filter((b) => b.tournament_name === tName);
    // Scoped to the bracket actually being viewed — a tournament can span
    // several games, and having a pick in one shouldn't show "My picks" on
    // brackets for games the user didn't bet on.
    const activeGameBets = activeTabData ? tournBets.filter((b) => b.game_name === activeTabData.gameName) : [];

    return (
      <div key={tName} className={`live-tourney-pill${hasLive ? ' has-live' : ''}`}>
        {renderTourneyHeader({
          name: tName, logoUrl: tLogo, date: tDate, city: tCity, country: tCountry,
          numEntrants: tNumEntrants, hasLive, isExpanded, onToggle: () => toggleTourney(tName),
        })}
        {isExpanded && (
          <div className="live-tourney-pill-body">
            <GameTabStrip
              tabs={tTabs}
              activeKey={activeTabKey}
              onSelect={(key) => setActiveTabs((prev) => ({ ...prev, [tName]: key }))}
            />
            {activeTabData && (
              <section className="live-tournament" role="tabpanel">
                <div className="live-game">
                  {activeGameBets.length > 0 && (
                    <button
                      className={`live-pnl-toggle live-pnl-toggle--bracket${showPnl ? ' active' : ''}`}
                      type="button"
                      onClick={() => setShowPnl((v) => !v)}
                    >
                      My picks
                    </button>
                  )}
                  <TrackerPanel
                    tournamentId={activeTabData.mkts[0]?.tournament_id}
                    gameId={activeTabData.mkts[0]?.game_id}
                    top8Status={activeTabData.isSettled ? 'done' : activeTabData.mkts.some((m) => m.state === 'open' || m.state === 'closed') ? 'live' : 'next'}
                    bracket={
                      <Bracket
                        markets={activeTabData.mkts}
                        slip={slip}
                        onPick={togglePick}
                        demoControls={demo ? renderDemoControls : null}
                        bets={showPnl ? Object.fromEntries(activeGameBets.map((b) => [b.market_id, b])) : {}}
                      />
                    }
                  />
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    );
  });

  const buildGroups = (mkts) => {
    const g = {};
    for (const m of mkts) {
      if (!g[m.tournament_name]) g[m.tournament_name] = {
        logoUrl: m.tournament_logo_url || null,
        date: m.tournament_date || null,
        city: m.tournament_city || null,
        country: m.tournament_country || null,
        numEntrants: m.tournament_num_entrants || null,
        games: {},
      };
      g[m.tournament_name].games[m.game_name] = g[m.tournament_name].games[m.game_name] || [];
      g[m.tournament_name].games[m.game_name].push(m);
    }
    return g;
  };
  const groups = buildGroups(markets);

  // Past-section filter options (derived from the raw past markets, not groups).
  const pastYears = [...new Set(pastMarkets.map((m) => (m.tournament_date || '').slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a));
  const pastTournaments = [...new Set(pastMarkets.map((m) => m.tournament_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const pastGames = [...new Set(pastMarkets.map((m) => m.game_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  // Apply the active filter before grouping, then paginate over tournaments.
  const filteredPast = pastMarkets.filter((m) =>
    (pastFilter.year === 'all' || (m.tournament_date || '').slice(0, 4) === pastFilter.year) &&
    (pastFilter.tournament === 'all' || m.tournament_name === pastFilter.tournament) &&
    (pastFilter.game === 'all' || m.game_name === pastFilter.game));
  const pastGroups = buildGroups(filteredPast);
  const pastEntries = Object.entries(pastGroups).sort(([, a], [, b]) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
  const shownPastGroups = Object.fromEntries(pastEntries.slice(0, pastVisible));

  const renderPastSection = () => (
    <>
      <div className="brackets-section-head">
        <div className={`brackets-section-label${pastVisible > 0 ? ' brackets-section-label--active' : ''}`}>Past Tournaments</div>
        <div className="load-more-row">
          {pastEntries.length > pastVisible && (
            <button className="load-more" onClick={() => setPastVisible((n) => n + 5)}>Show more ({pastEntries.length - pastVisible} more)</button>
          )}
          {pastVisible > 0 && (
            <button className="load-more load-more--less" onClick={() => setPastVisible((n) => Math.max(0, n - 5))}>Show less ({pastVisible} left)</button>
          )}
        </div>
      </div>
      {renderPills(shownPastGroups)}
    </>
  );

  // Sort games: closed (set in progress) first, then open, then pending, then settled
  const STATE_PRIORITY = { closed: 0, open: 1, pending: 2, settled: 3 };
  const gamePriority = (mkts) =>
    Math.min(...mkts.map((m) => STATE_PRIORITY[m.state] ?? 4));

  const shortTag = (name) => (name && name.includes('|') ? name.split('|').pop().trim() : name);

  return (
    <div className="live-layout">
      <div className="live-main">
        <h1 className="sr-only">Brackets</h1>
        {demoEnabled && (
          <div className="live-toolbar">
            <button type="button" className="live-demo-toggle" onClick={() => setDemo((d) => !d)}>
              {demo ? 'Hide demo tools' : 'Demo tools'}
            </button>
            {demo && (
              <>
                <button type="button" className="live-demo-seed" onClick={() => demoAction('/api/live/seed-demo')}>
                  Seed demo markets
                </button>
                <button type="button" className="live-demo-reset" onClick={() => demoAction('/api/live/demo/reset')}>
                  Reset
                </button>
                <span className="live-demo-hint">Use the controls on each card to start/settle a set.</span>
              </>
            )}
          </div>
        )}
        {error && <p className="error-message">{error}</p>}

        {pastMarkets.length > 0 && (
          <TournamentFilterBar
            years={pastYears} tournaments={pastTournaments} games={pastGames}
            value={pastFilter} onChange={setPastFilter}
            onClear={() => setPastFilter({ year: 'all', tournament: 'all', game: 'all' })}
            resultsCount={pastEntries.length + upcoming.length}
          />
        )}

        {(() => {
          const now = Date.now();
          const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
          const targetTimeOf = (t) => parseTournamentDate(t.date)?.getTime();
          const isHappeningNow = (t) => {
            if (t.isLive) return true;
            const target = targetTimeOf(t);
            return target != null && !isNaN(target) && target <= now;
          };

          // Once a tournament's Top 8 bracket actually has real markets, it
          // gets its own pill further down via renderPills(groups) - showing
          // it again here too would duplicate it on the page.
          const upcomingNotYetMarketed = upcoming.filter((item) => !groups[item.tournament.name]);

          // upcoming is sorted furthest-date-first (see getUpcoming()'s
          // `ORDER BY date(date) DESC`). Split into what's live right now
          // (any count, no cap) vs. what hasn't started yet, then pick the
          // next-up window off the NOT-STARTED set specifically - a
          // tournament that's already live belongs in Live, never Next Up,
          // no matter how its date sorts.
          const liveNow = [];
          const notStarted = [];
          for (const item of upcomingNotYetMarketed) (isHappeningNow(item.tournament) ? liveNow : notStarted).push(item);

          const notStartedSoonestFirst = [...notStarted].reverse();
          const nextUp = notStartedSoonestFirst
            .filter((item) => {
              const target = targetTimeOf(item.tournament);
              return target != null && target - now <= SEVEN_DAYS_MS;
            })
            .slice(0, 5);
          const nextUpIds = new Set(nextUp.map((item) => item.tournament.id));
          // Keeps notStarted's original furthest-first order, matching the
          // existing Future Tournaments show-more/less behavior below.
          const futureRest = notStarted.filter((item) => !nextUpIds.has(item.tournament.id));

          const renderUpcomingPill = ({ tournament: t, games }, { highlighted = false, hideCountdown = false } = {}) => {
            const isExpanded = expandedTourneys.has(t.name);
            return (
              <div key={t.id} className={`live-tourney-pill${highlighted ? ' live-tourney-pill--next-up' : ''}`}>
                {renderTourneyHeader({
                  name: t.name, logoUrl: t.logoUrl, date: t.date, city: t.city, country: t.country,
                  numEntrants: t.numEntrants, hasLive: false, isExpanded, onToggle: () => toggleTourney(t.name),
                  countdown: !hideCountdown && (
                    <div className="live-tourn-header-countdown">
                      <Countdown date={t.date} compact />
                    </div>
                  ),
                })}
                {isExpanded && (
                  <div className="live-tourney-pill-body">
                    <WaitingRoom tournament={t} games={games || []} headerless />
                  </div>
                )}
              </div>
            );
          };
          return (
            <>
              {futureRest.length > 0 && (
                <>
                  <div className="brackets-section-head">
                    <div className={`brackets-section-label${futureVisible > 0 ? ' brackets-section-label--active' : ''}`}>Future Tournaments</div>
                    <div className="load-more-row">
                      {futureRest.length > futureVisible && (
                        <button className="load-more" onClick={() => setFutureVisible((n) => n + 5)}>
                          Show more ({futureRest.length - futureVisible} more)
                        </button>
                      )}
                      {futureVisible > 0 && (
                        <button className="load-more load-more--less" onClick={() => setFutureVisible((n) => Math.max(0, n - 5))}>Show less ({futureVisible} left)</button>
                      )}
                    </div>
                  </div>
                  {futureRest.slice(Math.max(0, futureRest.length - futureVisible)).map((item) => renderUpcomingPill(item))}
                </>
              )}
              {nextUp.length > 0 && (
                <>
                  <div className="brackets-next-up-label">Next Up</div>
                  {nextUp.map((item) => renderUpcomingPill(item))}
                </>
              )}
              {liveNow.length > 0 && (
                <>
                  <div className="brackets-live-label">
                    <span className="brackets-live-dot" aria-hidden="true" />
                    Happening Now
                  </div>
                  {liveNow.map((item) => renderUpcomingPill(item, { highlighted: true, hideCountdown: true }))}
                </>
              )}
            </>
          );
        })()}
        {markets.length === 0 && upcoming.length === 0 && (
          <div className="live-empty">
            <h2>No live markets right now</h2>
            <p>Markets open automatically when a tracked tournament reaches Top 8.</p>
          </div>
        )}
        {markets.length > 0 && renderPills(groups)}
        {pastMarkets.length > 0 && renderPastSection()}
      </div>

      {/* Bet slip lives in a collapsible drawer so the bracket always gets the
          full page width. Only present once markets are live (nothing to bet in
          the waiting state). On mobile it stacks below the bracket (see CSS). */}
      {markets.length > 0 && (
        <>
          {!slipOpen && (
            <button
              type="button"
              className="live-drawer-tab"
              onClick={() => setSlipOpen(true)}
              aria-label="Open pick slip"
            >
              Slip ({Object.keys(slip).length})
            </button>
          )}
          {slipOpen && <div className="live-drawer-scrim" onClick={closeSlip} />}
          <div className={`live-drawer${slipOpen ? ' open' : ''}`}>
            <button
              type="button"
              className="live-drawer-close"
              onClick={closeSlip}
              aria-label="Close pick slip"
            >
              ‹ Close
            </button>
            <div className="live-drawer-body">
              {renderSlip()}
              {renderMyBets()}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default LiveBetting;
