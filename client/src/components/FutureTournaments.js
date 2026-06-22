import React, { useEffect, useState, useRef, useCallback } from 'react';
import './FutureTournaments.css';
import { getGameAlt, getGameLogoSources, getGameLogoStyle } from '../utils/gameLogos';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import Countdown from './Countdown';
import StakeStepper from './StakeStepper';
// Futures stakes/payouts are stored in whole Fight Money units, so convert to
// cents (×100) before the FM formatter, matching Home.js.
import { fmAmount } from '../utils/money';
import { apiFetch } from '../utils/api';

// Defined at module scope so their component identity is stable across
// FutureTournaments re-renders (e.g. every stake keystroke). Defining them
// inside the parent recreates the type each render, remounting every logo
// and making the images flicker.
const GameTitle = ({ name, height = 28 }) => {
  const [error, setError] = useState(false);
  const [src, setSrc] = useState(null);
  const candidates = Object.values(getGameLogoSources(name || '')).filter(Boolean);

  useEffect(() => {
    setError(false);
    setSrc(candidates[0] || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const handleError = () => {
    const currentIndex = candidates.indexOf(src);
    if (currentIndex + 1 < candidates.length) {
      setSrc(candidates[currentIndex + 1]);
    } else {
      setError(true);
    }
  };

  if (!name) return null;

  if (error || !src) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', minHeight: `${height}px` }}>
        <h3 style={{ margin: 0 }}>{name}</h3>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', minHeight: `${height}px` }}>
      {!error && src && (
        <img
          src={src}
          alt={getGameAlt(name)}
          style={getGameLogoStyle(name, height)}
          onError={handleError}
        />
      )}
      {error && (
        <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{name}</span>
      )}
    </div>
  );
};

const TournamentLogo = ({ name, logoUrl, height = 24 }) => {
  const [index, setIndex] = useState(0);
  if (!name) return null;

  const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name);
  const candidates = [logoUrl, avif, webp, png, jpg, jpeg].filter(Boolean);
  const src = candidates[index];

  if (!src) return null;

  return (
    <img
      src={src}
      alt={getTournamentAlt(name)}
      style={getTournamentLogoStyle(name, height)}
      title={name}
      onError={() => setIndex((i) => i + 1)}
    />
  );
};

const FutureTournaments = () => {
  const [tournaments, setTournaments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [slip, setSlip] = useState({}); // Pending bet selections, keyed tournament_game_player
  const [placedBets, setPlacedBets] = useState({}); // Already-placed bet amounts, same key
  const [placing, setPlacing] = useState(false);
  const [placeMsg, setPlaceMsg] = useState(null);
  const [tournamentGames, setTournamentGames] = useState({});
  const [playerStats, setPlayerStats] = useState({}); // Tracks live odds and totals dynamically

  // Filters
  const [filterTournament, setFilterTournament] = useState('');
  const [filterGame, setFilterGame] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedGames, setExpandedGames] = useState(() => new Set()); // collapsed by default
  const toggleGame = (key) => setExpandedGames((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  // Players/odds are loaded lazily — only when a game table is opened — so the
  // initial page load isn't blocked fetching seeds for collapsed games. The ref
  // guards against duplicate fetches on repeated toggles.
  const requestedPlayers = useRef(new Set());
  const loadPlayers = useCallback(async (tournamentId, gameId) => {
    const key = `${tournamentId}_${gameId}`;
    if (requestedPlayers.current.has(key)) return;
    requestedPlayers.current.add(key);
    try {
      const res = await fetch(`/api/game/${tournamentId}/${gameId}/players`);
      if (res.ok) {
        const players = await res.json();
        setPlayerStats((prev) => ({ ...prev, [key]: players }));
      } else {
        requestedPlayers.current.delete(key); // allow a retry next time
      }
    } catch {
      requestedPlayers.current.delete(key);
    }
  }, []);

  const userId = localStorage.getItem('userId');

  useEffect(() => {
    const fetchTournamentsAndBets = async () => {
      try {
        const [tournamentsResponse, betsResponse] = await Promise.all([
          fetch('/api/tournaments'),
          apiFetch(`/api/bets?userId=${userId}`),
        ]);

        if (!tournamentsResponse.ok) {
          throw new Error('Failed to fetch tournaments.');
        }

        const tournamentsData = await tournamentsResponse.json();

        // Track already-placed bets (by player) so rows can offer "Adjust".
        // This does NOT seed the slip — the slip stays empty until you act.
        if (betsResponse.ok) {
          const betsData = await betsResponse.json();
          const placed = {};
          betsData.forEach((bet) => {
            const key = `${bet.tournament_id}_${bet.game_id}_${bet.player_id}`;
            placed[key] = { amount: bet.amount, odds: bet.locked_odds };
          });
          setPlacedBets(placed);
        }

        // Client-side guard: filter past tournaments and sort by nearest date
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Normalize today to the start of the day
        const upcoming = (tournamentsData || [])
          .filter(t => {
            const d = new Date(t.date);
            return !isNaN(d) && d >= today;
          })
          .sort((a, b) => new Date(a.date) - new Date(b.date));

        // The slip starts empty — it stages new selections only. Already-placed
        // bets stay committed server-side and are not shown here.
        setTournaments(upcoming);
  
        // Fetch games for all tournaments
        const gameRequests = upcoming.map(async (tournament) => {
          const response = await fetch(`/api/tournament/${tournament.id}/games`);
          if (response.ok) {
            const gamesData = await response.json();
            return { tournamentId: tournament.id, games: gamesData };
          }
          return { tournamentId: tournament.id, games: [] };
        });
  
        const gameResults = await Promise.all(gameRequests);
        const updatedTournamentGames = {};
        gameResults.forEach(({ tournamentId, games }) => {
          updatedTournamentGames[tournamentId] = games;
        });
        setTournamentGames(updatedTournamentGames);
  
        // Players/seeds are no longer fetched here — they load lazily when a
        // game table is expanded (loadPlayers), so the page renders as soon as
        // the tournament + game lists are in.
  
      } catch (err) {
        console.error('Error fetching tournaments, games, or players:', err.message);
        setError('Failed to load future tournaments, games, or players.');
      } finally {
        setLoading(false);
      }
    };
  
    fetchTournamentsAndBets();
  }, [userId]);

  const addToSlip = (tournamentId, gameId, playerId, currentOdds, placed = null) => {
    const key = `${tournamentId}_${gameId}_${playerId}`;
    setSlip((prev) => {
      if (prev[key]) return prev; // already in the slip
      // Adjusting an existing bet pre-fills its current total and remembers the
      // already-locked portion so added stake blends at the current odds.
      const oldAmount = placed ? placed.amount : 0;
      const oldOdds = placed ? placed.odds : 0;
      const stake = placed ? String(placed.amount) : '';
      return {
        ...prev,
        [key]: { tournamentId, gameId, playerId, currentOdds, oldAmount, oldOdds, stake },
      };
    });
    setPlaceMsg(null);
  };

  // Splits a slip entry's stake into the portion that keeps its original locked
  // odds and the newly-added portion priced at the current odds, then blends.
  const effectiveBet = (entry) => {
    const stake = Number(entry?.stake) || 0;
    const oldAmount = entry?.oldAmount || 0;
    const kept = Math.min(stake, oldAmount);
    const added = Math.max(0, stake - oldAmount);
    const payout = kept * (entry?.oldOdds || 0) + added * (entry?.currentOdds || 0);
    const odds = stake > 0 ? payout / stake : (entry?.currentOdds || 0);
    return { stake, oldAmount, kept, added, payout, odds };
  };

  const removeFromSlip = (key) => {
    setSlip((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

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
      // POST is one bet at a time; submit each selection in turn.
      for (const e of entries) {
        const response = await apiFetch('/api/bets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tournamentId: e.tournamentId,
            gameId: e.gameId,
            playerId: e.playerId,
            amount: Number(e.stake),
          }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || response.statusText);
        }
      }

      // Refresh pooled odds/totals for every game that was bet on.
      const affected = Array.from(
        new Set(entries.map((e) => `${e.tournamentId}_${e.gameId}`))
      );
      const refreshed = await Promise.all(
        affected.map(async (gk) => {
          const [tId, gId] = gk.split('_');
          const r = await fetch(`/api/game/${tId}/${gId}/players`);
          return { key: gk, players: r.ok ? await r.json() : [] };
        })
      );
      setPlayerStats((prev) => {
        const next = { ...prev };
        refreshed.forEach(({ key, players }) => { next[key] = players; });
        return next;
      });

      // Re-read placed bets so rows show "Adjust" with the authoritative
      // blended odds the server just computed.
      const betsRes = await apiFetch(`/api/bets?userId=${userId}`);
      if (betsRes.ok) {
        const betsData = await betsRes.json();
        const placed = {};
        betsData.forEach((bet) => {
          const key = `${bet.tournament_id}_${bet.game_id}_${bet.player_id}`;
          placed[key] = { amount: bet.amount, odds: bet.locked_odds };
        });
        setPlacedBets(placed);
      }

      setSlip({});
      setPlaceMsg(`Placed ${entries.length} bet${entries.length > 1 ? 's' : ''} successfully.`);
    } catch (err) {
      console.error('Error placing bets:', err.message);
      setPlaceMsg(`Failed to place bets: ${err.message}`);
    } finally {
      setPlacing(false);
    }
  };

  // Rendered as a plain function (not a <Component/>) so the stake inputs keep
  // focus across re-renders instead of remounting on each keystroke.
  const renderBetSlip = () => {
    const entries = Object.entries(slip);
    const totalStake = entries.reduce((s, [, e]) => s + (Number(e.stake) || 0), 0);
    const totalPayout = entries.reduce((s, [, e]) => s + effectiveBet(e).payout, 0);

    const lookup = (e) => {
      const t = tournaments.find((t) => t.id === e.tournamentId);
      const g = (tournamentGames[e.tournamentId] || []).find((g) => g.game_id === e.gameId);
      const p = (playerStats[`${e.tournamentId}_${e.gameId}`] || []).find(
        (p) => p.player_id === e.playerId
      );
      return {
        tournamentName: t?.name || 'Tournament',
        gameName: g?.game_name || 'Game',
        playerName: p?.player_name || 'Competitor',
      };
    };

    return (
      <aside className="bet-slip">
        <div className="bet-slip-header">Your Slip ({entries.length})</div>
        {entries.length === 0 ? (
          <p className="bet-slip-empty">Add players to start building your slip.</p>
        ) : (
          <>
            <ul className="bet-slip-list">
              {entries.map(([key, e]) => {
                const { tournamentName, gameName, playerName } = lookup(e);
                const eff = effectiveBet(e);
                // Show the blend only when added stake actually prices differently.
                const blended =
                  eff.kept > 0 && eff.added > 0 && e.oldOdds !== e.currentOdds;
                return (
                  <li key={key} className="bet-slip-item">
                    <div className="bet-slip-item-info">
                      <span className="bet-slip-player">
                        {playerName} <span className="bet-slip-odds">@{eff.odds.toFixed(2)}</span>
                      </span>
                      <span className="bet-slip-meta">{gameName} · {tournamentName}</span>
                      {blended && (
                        <span className="bet-slip-blend">
                          {fmAmount(Math.round(eff.kept * 100))} FM @{(e.oldOdds || 0).toFixed(2)} + {fmAmount(Math.round(eff.added * 100))} FM @{(e.currentOdds || 0).toFixed(2)}
                        </span>
                      )}
                    </div>
                    <div className="bet-slip-item-stake">
                      <StakeStepper value={e.stake} onChange={(v) => updateStake(key, v)} />
                      <span className="bet-slip-payout">→ {fmAmount(Math.round(eff.payout * 100))} FM</span>
                      <button
                        type="button"
                        className="bet-slip-remove"
                        aria-label="Remove"
                        onClick={() => removeFromSlip(key)}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="bet-slip-totals">
              <div><span>Stake</span><strong>{fmAmount(Math.round(totalStake * 100))} FM</strong></div>
              <div><span>Projected payout</span><strong>{fmAmount(Math.round(totalPayout * 100))} FM</strong></div>
            </div>
            <p className="bet-slip-note">
              Odds are pooled and may shift as bets are placed. When you adjust a bet,
              your original stake keeps its locked odds and only the added stake prices
              at the current odds.
            </p>
            <button
              type="button"
              className="bet-slip-place"
              disabled={placing || totalStake <= 0}
              onClick={placeBets}
            >
              {placing ? 'Placing…' : 'Place Bets'}
            </button>
          </>
        )}
        {placeMsg && <p className="bet-slip-msg">{placeMsg}</p>}
      </aside>
    );
  };

  if (loading) return <p>Loading future tournaments...</p>;
  if (error) return <p className="error-message">{error}</p>;

  // Build filter option sets
  const allGames = Array.from(new Set(
    Object.values(tournamentGames).flat().map(g => g.game_name)
  )).sort((a, b) => a.localeCompare(b));

  const tournamentNames = Array.from(new Set(
    tournaments.map(t => t.name)
  )).sort((a, b) => a.localeCompare(b));

  // Apply filters
  const filteredTournaments = tournaments.filter(t => {
    const tournamentMatch = !filterTournament || t.name === filterTournament;
    const gameMatch = !filterGame || (tournamentGames[t.id]?.some(g => g.game_name === filterGame));
    return tournamentMatch && gameMatch;
  });

  const clearFilters = () => {
    setFilterTournament('');
    setFilterGame('');
  };

  // Active filters drive the toggle's count badge + the removable chips.
  const activeFilters = [
    filterTournament && { key: 'tournament', label: filterTournament, clear: () => setFilterTournament('') },
    filterGame && { key: 'game', label: filterGame, clear: () => setFilterGame('') },
  ].filter(Boolean);

  return (
    <div className="future-layout">
      <div className="future-tournaments-container">
      {/* Visible title intentionally omitted; the navbar marks the page. */}
      <h1 className="sr-only">Futures</h1>
      <div className="filter-bar">
        <button
          type="button"
          className={`filter-toggle${activeFilters.length ? ' has-active' : ''}`}
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
        >
          <svg className="filter-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
          </svg>
          Filters
          {activeFilters.length > 0 && <span className="filter-count">{activeFilters.length}</span>}
          <span className={`filter-toggle-chevron${filtersOpen ? ' open' : ''}`} aria-hidden="true">▾</span>
        </button>

        {activeFilters.map((f) => (
          <button key={f.key} type="button" className="filter-chip" onClick={f.clear} title={`Remove ${f.label}`}>
            {f.label}<span className="chip-x" aria-hidden="true">×</span>
          </button>
        ))}

        <span className="results-count">Showing {filteredTournaments.length} of {tournaments.length}</span>
      </div>

      {filtersOpen && (
        <div className="filter-panel">
          <div className="filter-group">
            <label htmlFor="ft-tournament">Tournament</label>
            <select
              id="ft-tournament"
              className="filter-select"
              value={filterTournament}
              onChange={(e) => setFilterTournament(e.target.value)}
            >
              <option value="">All</option>
              {tournamentNames.map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div className="filter-group">
            <label htmlFor="ft-game">Game</label>
            <select
              id="ft-game"
              className="filter-select"
              value={filterGame}
              onChange={(e) => setFilterGame(e.target.value)}
            >
              <option value="">All</option>
              {allGames.map(g => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
          {activeFilters.length > 0 && (
            <button className="clear-filters" onClick={clearFilters}>Clear</button>
          )}
        </div>
      )}
      {tournaments.length === 0 && (
        <p>No upcoming tournaments available right now.</p>
      )}
      {filteredTournaments.map((tournament) => (
        <div key={tournament.id} className="tournament">
          <div className="tournament-header">
            <h2 style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
              <TournamentLogo name={tournament.name} logoUrl={tournament.logoUrl} height={48} />
              <span>{tournament.name}</span>
            </h2>
            <div className="tournament-details">
              <p>
                <strong>Date:</strong> {new Date(tournament.date + 'T00:00:00').toLocaleDateString()}
              </p>
              <p>
                <strong>Location:</strong> {tournament.location.city}, {tournament.location.country}
              </p>
            </div>
            <Countdown date={tournament.date} />
          </div>
  
          {(() => {
            const gamesForTournament = tournamentGames[tournament.id] || [];
            // Most-entered game first; games without a count sort to the bottom.
            const sortedGames = [...gamesForTournament].sort(
              (a, b) => (b.num_entrants || 0) - (a.num_entrants || 0)
            );
            const gamesToShow = filterGame
              ? sortedGames.filter(g => g.game_name === filterGame)
              : sortedGames;
            if (gamesToShow.length === 0) {
              return (
                <p className="futures-pending">
                  Futures open once the bracket is seeded (about {21} days before the event). Check back closer to the date.
                </p>
              );
            }
            return gamesToShow.map((game) => {
              const gameKey = `${tournament.id}_${game.game_id}`;
              const isExpanded = expandedGames.has(gameKey);
              return (
              <div key={game.game_id} className={`game-section ${isExpanded ? 'expanded' : 'collapsed'}`}>
                <button type="button" className="game-toggle" onClick={() => { toggleGame(gameKey); loadPlayers(tournament.id, game.game_id); }} aria-expanded={isExpanded}>
                  <span className="game-toggle-name"><GameTitle name={game.game_name} height={34} /></span>
                  {game.num_entrants > 0 && (
                    <span className="game-entrants" title={`${game.num_entrants.toLocaleString()} entrants on Start.gg`}>
                      {game.num_entrants.toLocaleString()} <span className="ge-label">entrants</span>
                    </span>
                  )}
                  <span className={`game-toggle-chevron ${isExpanded ? 'open' : ''}`} aria-hidden="true">▾</span>
                </button>
                {isExpanded && (
                  <>
                <p className="seed-caption">Win % implied from Start.gg seeding.</p>
                <div className="table-scroll">
                <table className="tournament-table">
                  <thead>
                    <tr>
                      <th>Seed</th>
                      <th>Competitor</th>
                      <th className="winpct-col">Win %</th>
                      <th>Odds</th>
                      <th>Payout</th>
                      <th>Bet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {playerStats[`${tournament.id}_${game.game_id}`]?.map((player) => {
                      const key = `${tournament.id}_${game.game_id}_${player.player_id}`;
                      const inSlip = Boolean(slip[key]);
                      const placed = placedBets[key];
                      const hasPlaced = placed != null;
                      const label = inSlip ? 'Added ✓' : hasPlaced ? 'Adjust' : '+ Add';
                      const className = inSlip
                        ? 'slip-toggle added'
                        : hasPlaced
                        ? 'slip-toggle adjust'
                        : 'slip-toggle';
                      const rowPayout = inSlip ? effectiveBet(slip[key]).payout : 0;

                      const isField = player.player_name === 'The Field';
                      const winPct = player.win_probability != null
                        ? `${(player.win_probability * 100).toFixed(1)}%`
                        : '—';

                      return (
                        <tr key={player.player_id} className={isField ? 'field-row' : ''}>
                          <td className="seed-cell">{player.seed_num != null ? `#${player.seed_num}` : (isField ? 'Field' : '—')}</td>
                          <td>{player.player_name}</td>
                          <td className="winpct-cell winpct-col">{winPct}</td>
                          <td>{player.live_odds?.toFixed(2)}</td>
                          <td>{fmAmount(Math.round(rowPayout * 100))} FM</td>
                          <td>
                            <button
                              type="button"
                              className={className}
                              onClick={() =>
                                inSlip
                                  ? removeFromSlip(key)
                                  : addToSlip(
                                      tournament.id,
                                      game.game_id,
                                      player.player_id,
                                      player.live_odds,
                                      hasPlaced ? placed : null
                                    )
                              }
                            >
                              {label}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {!playerStats[gameKey] && (
                      <tr><td colSpan="6" className="seed-caption" style={{ textAlign: 'center', padding: '18px' }}>Loading players…</td></tr>
                    )}
                  </tbody>
                </table>
                </div>
                  </>
                )}
              </div>
              );
            });
          })()}
        </div>
      ))}
      </div>
      {renderBetSlip()}
    </div>
  );

};

export default FutureTournaments;
