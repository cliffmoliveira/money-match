import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './DepositModal.css';

const PRESETS = [50, 100, 250, 500];
const fmt = (cents) => `$${((cents || 0) / 100).toFixed(2)}`;

/**
 * Play-money top-up modal.
 *
 * Props:
 *   isOpen       {boolean}              whether the modal is shown
 *   onClose      {() => void}           close handler (backdrop / × / Esc)
 *   balanceCents {number}               current wallet balance, in cents
 *   onConfirm    {(cents) => Promise}   called with the amount to add (cents);
 *                                       resolve to close, reject to show an error
 *
 * Example (in Navbar.js):
 *   const [depositOpen, setDepositOpen] = useState(false);
 *   const addFunds = async (cents) => {
 *     const res = await fetch('/api/wallet/deposit', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ userId: Number(userId), amountCents: cents }),
 *     });
 *     if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Deposit failed');
 *     setBalanceCents((await res.json()).balanceCents); // refresh the navbar badge
 *   };
 *   // <button className="navbar-deposit" onClick={() => setDepositOpen(true)}>Deposit</button>
 *   // <DepositModal isOpen={depositOpen} onClose={() => setDepositOpen(false)}
 *   //               balanceCents={balanceCents} onConfirm={addFunds} />
 */
const DepositModal = ({ isOpen, onClose, balanceCents, onConfirm }) => {
  const [amount, setAmount] = useState('100'); // dollars, as a string
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState(null);

  // Reset state whenever the modal opens.
  useEffect(() => {
    if (isOpen) { setAmount('100'); setError(null); setPlacing(false); }
  }, [isOpen]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const dollars = Number(amount) || 0;
  const valid = dollars > 0;

  const confirm = useCallback(async () => {
    if (!valid || placing) return;
    setPlacing(true);
    setError(null);
    try {
      await onConfirm(Math.round(dollars * 100));
      onClose();
    } catch (err) {
      setError(err.message || 'Could not add funds. Please try again.');
      setPlacing(false);
    }
  }, [valid, placing, dollars, onConfirm, onClose]);

  if (!isOpen) return null;

  // Render into document.body so the fixed overlay is positioned against the
  // viewport — not the navbar, whose backdrop-filter would otherwise become the
  // containing block for position: fixed and pin the modal to the top.
  return createPortal(
    <div className="deposit-overlay" onClick={onClose}>
      <div
        className="deposit-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Add play money"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="deposit-header">
          <span className="deposit-title">Add play money</span>
          <button className="deposit-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="deposit-body">
          <div className="deposit-balance">
            <span>Current balance</span>
            <span className="deposit-balance-val">{fmt(balanceCents)}</span>
          </div>

          <div className="deposit-label">Choose an amount</div>
          <div className="deposit-presets">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={`deposit-preset${Number(amount) === p ? ' active' : ''}`}
                onClick={() => setAmount(String(p))}
              >
                ${p}
              </button>
            ))}
          </div>

          <div className="deposit-label">Or enter your own</div>
          <div className="deposit-input">
            <span className="deposit-input-prefix">$</span>
            <input
              type="number"
              min="0"
              inputMode="decimal"
              placeholder="Custom amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            />
          </div>

          <p className="deposit-note">
            Play money only — MoneyMatch never uses real funds. Top up instantly and keep the
            bragging rights.
          </p>

          {error && <p className="deposit-error">{error}</p>}

          <button
            className="deposit-confirm"
            disabled={!valid || placing}
            onClick={confirm}
          >
            {placing ? 'Adding…' : `Add ${fmt(Math.round(dollars * 100))}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default DepositModal;
