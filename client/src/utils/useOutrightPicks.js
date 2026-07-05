import { useState, useEffect } from 'react';
import { apiFetch } from './api';

// Shared outright (tournament-winner) picks data + slip state for a single
// tournament/game — used by both WaitingRoom (pre-Top-8) and TrackerPanel
// (once real Top-8 markets exist), so the "Outright" pill and its picks
// panel behave identically in both places instead of only existing pre-Top-8.
//
// Fetches the seed list + whether picks are locked (GET .../players, which
// also reports futures.isFuturesLocked), and separately the user's own
// already-placed picks for this tournament/game (GET /api/bets, filtered
// client-side) so an existing pick stays visible/highlighted even once the
// panel is locked.
export default function useOutrightPicks(tournamentId, gameId) {
  const [seedRows, setSeedRows] = useState([]);
  const [locked, setLocked] = useState(false);
  const [myPicks, setMyPicks] = useState({}); // player_id -> { amount, lockedOdds }
  const [picksVersion, setPicksVersion] = useState(0); // bump to refetch myPicks after placing

  useEffect(() => {
    if (!gameId || !tournamentId) { setSeedRows([]); setLocked(false); return; }
    let active = true;
    setSeedRows([]);
    fetch(`/api/game/${tournamentId}/${gameId}/players`)
      .then((r) => (r.ok ? r.json() : { locked: false, entrants: [] }))
      .then(({ locked: isLocked, entrants }) => {
        if (!active) return;
        const seeded = (Array.isArray(entrants) ? entrants : [])
          .filter((r) => r.seed_num != null)
          .slice(0, 8);
        setSeedRows(seeded);
        setLocked(!!isLocked);
      })
      .catch(() => { if (active) { setSeedRows([]); setLocked(false); } });
    return () => { active = false; };
  }, [gameId, tournamentId]);

  useEffect(() => {
    if (!gameId || !tournamentId) { setMyPicks({}); return; }
    let active = true;
    apiFetch('/api/bets')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (!active) return;
        const mine = {};
        for (const b of Array.isArray(rows) ? rows : []) {
          if (String(b.tournament_id) === String(tournamentId) && String(b.game_id) === String(gameId)) {
            mine[b.player_id] = { amount: b.amount, lockedOdds: b.locked_odds };
          }
        }
        setMyPicks(mine);
      })
      .catch(() => { if (active) setMyPicks({}); });
    return () => { active = false; };
  }, [gameId, tournamentId, picksVersion]);

  // --- Slip (staged, not-yet-placed picks) ---
  const [slip, setSlip] = useState({});
  const [placing, setPlacing] = useState(false);
  const [placeMsg, setPlaceMsg] = useState(null);
  const [slipOpen, setSlipOpen] = useState(false);

  const onPick = (row) => {
    if (locked) return;
    const key = `outright_${row.player_id}`;
    let added = false;
    setSlip((prev) => {
      if (prev[key]) { const n = { ...prev }; delete n[key]; return n; } // toggle off
      added = true;
      return { ...prev, [key]: { gameId, playerId: row.player_id, playerName: row.player_name, odds: Number(row.live_odds) || 0, stake: '' } };
    });
    setPlaceMsg(null);
    if (added) setSlipOpen(true); // surface the slip only when adding a pick
  };
  const updateStake = (key, v) =>
    setSlip((p) => ({ ...p, [key]: { ...p[key], stake: String(v).replace(/[^0-9.]/g, '') } }));
  const removeFromSlip = (key) =>
    setSlip((p) => { const n = { ...p }; delete n[key]; return n; });

  const slipEntries = Object.entries(slip);
  const totalStake = slipEntries.reduce((sum, [, e]) => sum + (Number(e.stake) || 0), 0);

  const placeOutrights = async () => {
    const entries = slipEntries.filter(([, e]) => Number(e.stake) > 0);
    if (!entries.length) return;
    setPlacing(true); setPlaceMsg(null);
    try {
      for (const [, e] of entries) {
        const res = await apiFetch('/api/bets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tournamentId, gameId: e.gameId, playerId: e.playerId, amount: Number(e.stake) }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.statusText); }
      }
      setSlip({});
      setPlaceMsg(`Placed ${entries.length} outright${entries.length > 1 ? 's' : ''}.`);
      window.dispatchEvent(new Event('mm-wallet-changed'));
      setPicksVersion((v) => v + 1); // pull the just-placed pick(s) into myPicks
    } catch (err) { setPlaceMsg(`Could not place: ${err.message}`); }
    finally { setPlacing(false); }
  };

  return {
    seedRows, locked, myPicks,
    slip, onPick, updateStake, removeFromSlip,
    placing, placeMsg, slipOpen, setSlipOpen, slipEntries, totalStake, placeOutrights,
  };
}
