import React from 'react';
import StakeStepper from './StakeStepper';
import { fmAmount } from '../utils/money';

// Bottom-sheet slip drawer for staged (not-yet-placed) outright picks —
// shared by WaitingRoom and TrackerPanel. Opened via a sticky floating
// "Picks (n)" tab so it's reachable without scrolling past whichever view
// is active. Renders nothing once every staged pick has been placed
// (slipEntries empty) — a locked panel never stages anything new, so this
// naturally disappears once a tournament starts.
const OutrightSlipDrawer = ({
  slipEntries, slipOpen, setSlipOpen, updateStake, removeFromSlip,
  totalStake, placing, placeMsg, placeOutrights,
}) => {
  if (slipEntries.length === 0) return null;
  return (
    <>
      {!slipOpen && (
        <div className="wr-drawer-tab-row">
          <button
            type="button"
            className="wr-drawer-tab"
            onClick={() => setSlipOpen(true)}
            aria-label="Open outright picks slip"
          >
            Picks ({slipEntries.length})
          </button>
        </div>
      )}
      {slipOpen && <div className="wr-drawer-scrim" onClick={() => setSlipOpen(false)} />}
      <div className={`wr-drawer${slipOpen ? ' open' : ''}`}>
        <button
          type="button"
          className="wr-drawer-close"
          onClick={() => setSlipOpen(false)}
          aria-label="Close outright picks slip"
        >
          ‹ Close
        </button>
        <div className="wr-drawer-body">
          <div className="wr-outright-slip">
            <div className="wr-slip-title">Outright picks</div>
            <div className="wr-slip-rows">
              {slipEntries.map(([key, e]) => {
                const payout = Math.round((Number(e.stake) || 0) * e.odds * 100);
                return (
                  <div className="wr-slip-row" key={key}>
                    <div className="wr-slip-pick">
                      <span className="wr-slip-name">{e.playerName}</span>
                      <span className="wr-slip-odds">@{e.odds.toFixed(2)}</span>
                    </div>
                    <StakeStepper value={e.stake} onChange={(v) => updateStake(key, v)} />
                    <span className="wr-slip-payout">→ {fmAmount(payout)} FM</span>
                    <button
                      type="button"
                      className="wr-slip-remove"
                      aria-label={`Remove ${e.playerName}`}
                      onClick={() => removeFromSlip(key)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="wr-slip-footer">
              <div className="wr-slip-total">
                <span className="wr-slip-total-label">Total stake</span>
                <span className="wr-slip-total-val">{fmAmount(Math.round(totalStake * 100))} FM</span>
              </div>
              <p className="wr-slip-note">Fixed odds — your stake locks the price.</p>
              <button
                type="button"
                className="wr-slip-place"
                disabled={placing || totalStake <= 0}
                onClick={placeOutrights}
              >
                {placing ? 'Placing…' : 'Place Outrights'}
              </button>
              {placeMsg && <p className="wr-slip-msg">{placeMsg}</p>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default OutrightSlipDrawer;
