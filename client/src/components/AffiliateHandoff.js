import React, { useState } from 'react';

// Minimal "Place on [Book]" trigger: POST the pick context to /api/affiliate/click,
// then open the returned deep link. (The gated/eligibility CTA is separate, deferred work.)
export default function AffiliateHandoff({ context, label = 'Place on Mock Book' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const go = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/affiliate/click', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context),
      });
      if (!res.ok) throw new Error(`click failed (${res.status})`);
      const { deep_link_url } = await res.json();
      window.open(deep_link_url, '_blank', 'noopener');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <span>
      <button onClick={go} disabled={busy}>{busy ? 'Opening…' : label}</button>
      {error && <span style={{ color: 'var(--live-text)', marginLeft: 8 }}>{error}</span>}
    </span>
  );
}
