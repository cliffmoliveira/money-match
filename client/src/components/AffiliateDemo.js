import React, { useState } from 'react';
import AffiliateHandoff from './AffiliateHandoff';

// Tiny dev surface to exercise the loop without touching the betting slips.
export default function AffiliateDemo() {
  const [ctx, setCtx] = useState({
    userId: Number(localStorage.getItem('userId')) || 1, book: 'mock_book',
    event_id: 'evo-2026', match_id: 'm-001', market_id: 'mk-sf6-outright',
    selection_id: 'sel-mena', participant_id: 'p-mena', source_page: 'match_detail',
  });
  const set = (k) => (e) => setCtx({ ...ctx, [k]: e.target.value });
  return (
    <div style={{ maxWidth: 640, margin: '40px auto', fontFamily: "'Hanken Grotesk', sans-serif", color: 'var(--text)' }}>
      <h1 style={{ fontFamily: "'Saira', sans-serif" }}>Affiliate handoff demo</h1>
      <p style={{ color: 'var(--muted)' }}>Fires the click → deep-link → mock-book loop.</p>
      {['event_id', 'match_id', 'market_id', 'selection_id', 'participant_id', 'source_page'].map((k) => (
        <label key={k} style={{ display: 'block', margin: '8px 0' }}>
          {k}: <input value={ctx[k]} onChange={set(k)} style={{ width: 320 }} />
        </label>
      ))}
      <AffiliateHandoff context={ctx} />
    </div>
  );
}
