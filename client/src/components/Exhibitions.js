import React, { useState, useEffect } from 'react';
import ExhibitionSection from './ExhibitionSection';

const POLL_MS = 15000;

const Exhibitions = () => {
  const [live, setLive] = useState([]);
  const [past, setPast] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = () =>
      Promise.all([
        fetch('/api/exhibitions/live').then((r) => (r.ok ? r.json() : [])),
        fetch('/api/exhibitions/results').then((r) => (r.ok ? r.json() : [])),
      ])
        .then(([l, p]) => {
          if (!active) return;
          setLive(Array.isArray(l) ? l : []);
          setPast(Array.isArray(p) ? p : []);
          setLoading(false);
        })
        .catch(() => { if (active) setLoading(false); });

    load();
    const id = setInterval(load, POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, []);

  if (loading) return <p className="live-loading">Loading exhibitions…</p>;

  if (live.length === 0 && past.length === 0) {
    return (
      <div className="live-empty">
        <h2>No exhibitions yet</h2>
        <p>Special matches and celebrity showdowns will appear here.</p>
      </div>
    );
  }

  return (
    <div className="live-main">
      <h1 className="sr-only">Exhibitions</h1>
      <ExhibitionSection exhibitions={live} title="Live Exhibitions" />
      <ExhibitionSection exhibitions={past} title="Exhibition Results" layout="table" />
    </div>
  );
};

export default Exhibitions;
