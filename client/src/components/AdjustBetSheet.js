import React, { useEffect, useState } from 'react';
import StakeStepper from './StakeStepper';
import { apiFetch } from '../utils/api';
import { fmAmount } from '../utils/money';
import './AdjustBetSheet.css';

// Blend formula mirrors the server (POST /api/bets): the stake the bettor
// already had keeps its locked odds; only the *added* stake locks at the
// current odds. Reducing the stake keeps the existing blended odds.
function previewOdds(newAmount, currentStake, lockedOdds, currentOdds) {
  if (newAmount <= 0) return lockedOdds || 0;
  const kept = Math.min(newAmount, currentStake);
  const added = Math.max(0, newAmount - currentStake);
  const cur = currentOdds || lockedOdds || 0;
  return (kept * (lockedOdds || 0) + added * cur) / newAmount;
}

// Adjust or cancel a pending Futures bet without leaving the home page.
// Modal on desktop, bottom sheet on mobile. Reuses POST/DELETE /api/bets — no
// new accounting; the server enforces the futures lock and returns 409 if the
// event has started since the page loaded.
const AdjustBetSheet = ({ bet, onClose, onSaved }) => {
  const [stake, setStake] = useState(String(bet.stake));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const newAmount = Number(stake) || 0;
  const odds = previewOdds(newAmount, bet.stake, bet.lockedOdds, bet.currentOdds);
  const payoutCents = Math.round(newAmount * odds * 100);
  const unchanged = Math.abs(newAmount - bet.stake) < 0.005;
  const canSave = !busy && newAmount > 0 && !unchanged;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: bet.tournamentId, gameId: bet.gameId,
          playerId: bet.playerId, amount: newAmount,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Could not save the change.');
      }
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancelBet = async () => {
    setBusy(true); setError(null);
    try {
      // Remove ONLY this pick: POST amount 0 deletes the single
      // (tournament, game, player) row and is lock-guarded. DELETE /api/bets is
      // scoped to the whole game and would drop sibling picks in the same game.
      const res = await apiFetch('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId: bet.tournamentId, gameId: bet.gameId,
          playerId: bet.playerId, amount: 0,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Could not cancel the pick.');
      }
      onSaved();
    } catch (e) {
      setError(e.message);
      setConfirmingCancel(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="adjust-backdrop" onClick={() => !busy && onClose()}>
      <div className="adjust-sheet" role="dialog" aria-modal="true" aria-label="Adjust pick" onClick={(e) => e.stopPropagation()}>
        <div className="adjust-header">
          <span>Adjust pick</span>
          <button type="button" className="adjust-close" aria-label="Close" onClick={onClose} disabled={busy}>×</button>
        </div>

        <div className="adjust-body">
          <div className="adjust-meta">
            <div className="adjust-tournament">{bet.tournament}</div>
            <div className="adjust-pick">{bet.pick} · {bet.game}</div>
          </div>

          <label className="adjust-stake-label">Stake (FM)</label>
          <StakeStepper value={stake} onChange={setStake} ariaLabel="Pick stake" />

          <div className="adjust-payout">
            <span>Payout</span>
            <strong>{fmAmount(payoutCents)} FM</strong>
          </div>

          {error && <div className="adjust-error">{error}</div>}
        </div>

        <div className="adjust-actions">
          {confirmingCancel ? (
            <>
              <span className="adjust-confirm-text">Remove this pick?</span>
              <button type="button" className="adjust-btn ghost" onClick={() => setConfirmingCancel(false)} disabled={busy}>Keep</button>
              <button type="button" className="adjust-btn danger" onClick={cancelBet} disabled={busy}>Cancel pick</button>
            </>
          ) : (
            <>
              <button type="button" className="adjust-btn ghost" onClick={() => setConfirmingCancel(true)} disabled={busy}>Cancel pick</button>
              <button type="button" className="adjust-btn primary" onClick={save} disabled={!canSave}>Save changes</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdjustBetSheet;
