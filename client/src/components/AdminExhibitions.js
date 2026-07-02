import React, { useEffect, useState } from 'react';
import './AdminExhibitions.css';

const SECRET_KEY = 'mm-admin-secret';

const adminFetch = (url, options = {}) => fetch(url, {
  ...options,
  headers: {
    ...(options.headers || {}),
    'x-admin-secret': sessionStorage.getItem(SECRET_KEY) || '',
  },
});

const EMPTY_FORM = { player1_name: '', player2_name: '', game_name: '', tournament_name: '', event_date: '', notes: '' };

// Internal, operator-only tool for entering exhibition matches ahead of time
// (start.gg has no concept of exhibitions to pull from — see [[exhibitions.js]]).
// Not linked from the Navbar; reachable only by direct URL. Gated server-side
// by requireAdminSecret, not by user login — there's no admin-role system in
// this app, so the shared secret itself is the "admin login".
const AdminExhibitions = () => {
  const [secret, setSecret] = useState(sessionStorage.getItem(SECRET_KEY) || '');
  const [secretInput, setSecretInput] = useState('');
  const [authError, setAuthError] = useState(null);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [settleDrafts, setSettleDrafts] = useState({}); // id -> { winner_name, winner_score, loser_score }

  const load = async () => {
    setLoading(true);
    try {
      const res = await adminFetch('/api/admin/exhibitions');
      if (res.status === 403) {
        sessionStorage.removeItem(SECRET_KEY);
        setSecret('');
        setAuthError('That secret was rejected.');
        return;
      }
      if (res.ok) setRows(await res.json());
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (secret) load(); }, [secret]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitSecret = (e) => {
    e.preventDefault();
    sessionStorage.setItem(SECRET_KEY, secretInput);
    setAuthError(null);
    setSecret(secretInput);
  };

  const createExhibition = async (e) => {
    e.preventDefault();
    if (!form.player1_name.trim() || !form.player2_name.trim()) return;
    setCreating(true);
    try {
      const res = await adminFetch('/api/admin/exhibition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (res.ok) { setForm(EMPTY_FORM); await load(); }
    } catch { /* ignore */ } finally {
      setCreating(false);
    }
  };

  const openExhibition = async (id) => { await adminFetch(`/api/admin/exhibition/${id}/open`, { method: 'POST' }); load(); };
  const closeExhibition = async (id) => { await adminFetch(`/api/admin/exhibition/${id}/close`, { method: 'POST' }); load(); };

  const settle = async (id) => {
    const draft = settleDrafts[id];
    if (!draft?.winner_name) return;
    await adminFetch(`/api/admin/exhibition/${id}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    setSettleDrafts((d) => { const next = { ...d }; delete next[id]; return next; });
    load();
  };

  if (!secret) {
    return (
      <div className="admin-exh-page">
        <form className="admin-exh-gate" onSubmit={submitSecret}>
          <h1>Admin</h1>
          <input
            type="password"
            placeholder="Admin secret"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            autoFocus
          />
          <button type="submit">Enter</button>
          {authError && <p className="admin-exh-error">{authError}</p>}
        </form>
      </div>
    );
  }

  return (
    <div className="admin-exh-page">
      <h1>Exhibitions</h1>

      <form className="admin-exh-form" onSubmit={createExhibition}>
        <div className="admin-exh-form-row">
          <input placeholder="Player 1" value={form.player1_name} onChange={(e) => setForm({ ...form, player1_name: e.target.value })} required />
          <input placeholder="Player 2" value={form.player2_name} onChange={(e) => setForm({ ...form, player2_name: e.target.value })} required />
        </div>
        <div className="admin-exh-form-row">
          <input placeholder="Game" value={form.game_name} onChange={(e) => setForm({ ...form, game_name: e.target.value })} />
          <input placeholder="Tournament / event name" value={form.tournament_name} onChange={(e) => setForm({ ...form, tournament_name: e.target.value })} />
        </div>
        <div className="admin-exh-form-row">
          <input type="date" value={form.event_date} onChange={(e) => setForm({ ...form, event_date: e.target.value })} />
          <input placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>
        <button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create exhibition'}</button>
      </form>

      {loading ? (
        <p className="admin-exh-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="admin-exh-muted">No exhibitions yet.</p>
      ) : (
        <div className="admin-exh-list">
          {rows.map((r) => {
            const draft = settleDrafts[r.id] || { winner_name: '', winner_score: '', loser_score: '' };
            const setDraft = (patch) => setSettleDrafts((d) => ({ ...d, [r.id]: { ...draft, ...patch } }));
            return (
              <div key={r.id} className={`admin-exh-row admin-exh-row--${r.state}`}>
                <div className="admin-exh-row-main">
                  <span className="admin-exh-matchup">{r.player1_name} vs {r.player2_name}</span>
                  <span className={`admin-exh-state admin-exh-state--${r.state}`}>{r.state}</span>
                </div>
                <div className="admin-exh-row-meta">
                  {r.game_name && <span>{r.game_name}</span>}
                  {r.tournament_name && <span>{r.tournament_name}</span>}
                  {r.event_date && <span>{r.event_date}</span>}
                </div>

                {r.state === 'pending' && (
                  <button onClick={() => openExhibition(r.id)}>Open for picks</button>
                )}
                {r.state === 'open' && (
                  <button onClick={() => closeExhibition(r.id)}>Close (lock picks)</button>
                )}
                {r.state === 'closed' && (
                  <div className="admin-exh-settle">
                    <select value={draft.winner_name} onChange={(e) => setDraft({ winner_name: e.target.value })}>
                      <option value="">Winner…</option>
                      <option value={r.player1_name}>{r.player1_name}</option>
                      <option value={r.player2_name}>{r.player2_name}</option>
                    </select>
                    <input
                      type="number" placeholder="Winner score" value={draft.winner_score}
                      onChange={(e) => setDraft({ winner_score: e.target.value })}
                    />
                    <input
                      type="number" placeholder="Loser score" value={draft.loser_score}
                      onChange={(e) => setDraft({ loser_score: e.target.value })}
                    />
                    <button onClick={() => settle(r.id)} disabled={!draft.winner_name}>Settle</button>
                  </div>
                )}
                {r.state === 'settled' && (
                  <div className="admin-exh-result">
                    {r.winner_name} won{r.winner_score != null ? ` ${r.winner_score}-${r.loser_score}` : ''}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default AdminExhibitions;
