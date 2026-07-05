import React from 'react';

// Flat seed list for staging/viewing tournament-winner picks — shared by
// WaitingRoom (pre-Top-8) and TrackerPanel (once real Top-8 markets exist),
// so a placed pick stays visible/highlighted for the tournament's whole run,
// not just before it starts.
//
// `highlight` gates the "Your Pick" treatment behind the shared My Picks
// toggle in TrackerPanel (so it lines up with the same toggle's bracket
// highlighting there); WaitingRoom has no bracket to compete for attention
// with, so it always passes highlight=true.
const OutrightPanel = ({ seedRows, locked, slip, myPicks, onPick, highlight = true }) => {
  const hasMyPicks = Object.keys(myPicks).length > 0;
  return (
    <div className="wr-outright-panel">
      <p className="wr-proj-note">
        Pick who wins the whole tournament — fixed odds, locks the moment the bracket begins.
      </p>
      {seedRows.length === 0 ? (
        <p className="wr-empty">Seeding not available yet.</p>
      ) : (
        <div className="wr-outright-rows">
          {seedRows.map((row) => {
            const staged = Boolean(slip[`outright_${row.player_id}`]);
            const mine = highlight && myPicks[row.player_id];
            return (
              <button
                key={row.player_id}
                type="button"
                className={`wr-outright-row${staged ? ' picked' : ''}${mine ? ' confirmed' : ''}`}
                disabled={locked}
                onClick={() => onPick(row)}
              >
                <span className="wr-outright-seed">#{row.seed_num}</span>
                <span className="wr-outright-name">{row.player_name}</span>
                {mine && <span className="wr-outright-badge">Your Pick</span>}
                <span className="wr-outright-odds">{Number(row.live_odds).toFixed(2)}×</span>
              </button>
            );
          })}
        </div>
      )}
      {locked && seedRows.length > 0 && (
        <p className="wr-proj-note">
          {hasMyPicks
            ? 'Picks are locked — no changes once the bracket begins.'
            : 'Outright picks are closed — this tournament has started. Shown here as seeded.'}
        </p>
      )}
    </div>
  );
};

export default OutrightPanel;
