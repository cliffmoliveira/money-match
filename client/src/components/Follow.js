import React, { useEffect, useState } from 'react';
import './Follow.css';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { apiFetch } from '../utils/api';
import { formatTournamentDateTime } from '../utils/tournamentDate';
import { splitPlayerName } from '../utils/playerName';

// Stored player names carry the sponsor as ingested from start.gg ("WBG RB |
// MenaRD"), and that prefix can change release to release without the person
// behind it changing — see splitPlayerName's own doc comment. Lead with the
// gamerTag (what a follower actually recognizes) and show the sponsor only
// as a small label above it, same convention as Bracket.js's PlayerName /
// Home.js's BetPlayerName, so a sponsor swap doesn't reshuffle what's
// prominent in someone's Follow list.
const FollowPlayerName = ({ name, tagClassName, sponsorClassName }) => {
  const { sponsor, tag } = splitPlayerName(name);
  return (
    <span className="follow-name-stack">
      {sponsor && <span className={sponsorClassName}>{sponsor}</span>}
      <span className={tagClassName}>{tag}</span>
    </span>
  );
};

// Person outline shown when a player has no start.gg profile photo uploaded,
// or their photo fails to load. Mirrors Navbar's account-menu fallback.
const PersonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const PlayerAvatar = ({ url, size = 32 }) => {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (!url || failed) {
    return <span className="follow-avatar follow-avatar-fallback" style={style}><PersonIcon /></span>;
  }
  return (
    <img
      src={url}
      alt=""
      className="follow-avatar"
      style={style}
      onError={() => setFailed(true)}
    />
  );
};

const TournamentLogo = ({ name, height = 20 }) => {
  const [index, setIndex] = useState(0);
  if (!name) return null;
  const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name);
  const candidates = [avif, webp, png, jpg, jpeg].filter(Boolean);
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

const recordLine = (record) => `${record.wins}-${record.losses}`;

const Follow = () => {
  const [followed, setFollowed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const [selectedId, setSelectedId] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const loadFollowed = async () => {
    try {
      const res = await apiFetch('/api/follows');
      if (!res.ok) throw new Error('Failed to load followed competitors.');
      setFollowed(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadFollowed(); }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    let active = true;
    setSearching(true);
    const id = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/players/search?q=${encodeURIComponent(q)}`);
        if (res.ok && active) setResults(await res.json());
      } catch { /* ignore */ } finally {
        if (active) setSearching(false);
      }
    }, 250);
    return () => { active = false; clearTimeout(id); };
  }, [query]);

  // Toggling the same card closes it; picking a different one collapses the
  // old one and loads the new one in place.
  const toggleProfile = async (playerId) => {
    if (selectedId === playerId) { setSelectedId(null); setProfile(null); return; }
    setSelectedId(playerId);
    setProfileLoading(true);
    setProfile(null);
    try {
      const res = await apiFetch(`/api/players/${playerId}/profile`);
      if (res.ok) setProfile(await res.json());
    } catch { /* ignore */ } finally {
      setProfileLoading(false);
    }
  };

  const follow = async (playerId) => {
    try {
      const res = await apiFetch('/api/follows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      if (res.ok) await loadFollowed();
    } catch { /* ignore */ }
  };

  const unfollow = async (playerId) => {
    try {
      const res = await apiFetch(`/api/follows/${playerId}`, { method: 'DELETE' });
      if (res.ok) {
        setFollowed((list) => list.filter((p) => p.id !== playerId));
        if (selectedId === playerId) { setSelectedId(null); setProfile(null); }
      }
    } catch { /* ignore */ }
  };

  const followedIds = new Set(followed.map((p) => p.id));

  return (
    <div className="follow-page">
      <h1 className="follow-title">Follow</h1>
      <p className="follow-sub">Track competitors and see their record and how far they made it in each tournament.</p>

      <div className="follow-search">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search competitors…"
          className="follow-search-input"
        />
        {query.trim() && (
          <div className="follow-search-results">
            {searching && <div className="follow-muted">Searching…</div>}
            {!searching && results.length === 0 && <div className="follow-muted">No competitors found.</div>}
            {results.map((p) => (
              <div key={p.id} className="follow-search-row">
                <span className="follow-search-identity">
                  <PlayerAvatar url={p.photoUrl} size={26} />
                  <span className="follow-search-text">
                    <FollowPlayerName name={p.name} tagClassName="follow-search-name" sponsorClassName="follow-search-sponsor" />
                    <span className="follow-search-activity">{p.latestActivity || 'No tracked history yet'}</span>
                  </span>
                </span>
                {followedIds.has(p.id) ? (
                  <span className="follow-already">Following</span>
                ) : (
                  <button className="follow-btn" onClick={() => follow(p.id)}>Follow</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="follow-list">
        {loading && <p className="follow-muted">Loading…</p>}
        {error && <p className="error-message">{error}</p>}
        {!loading && !error && followed.length === 0 && (
          <p className="follow-muted">You're not following anyone yet — search above to get started.</p>
        )}
        {followed.map((p) => {
          const isOpen = selectedId === p.id;
          return (
            <div key={p.id} className={`follow-card${isOpen ? ' active' : ''}`}>
              <div className="follow-card-tap" onClick={() => toggleProfile(p.id)}>
                <div className="follow-card-main">
                  <span className="follow-card-identity">
                    <PlayerAvatar url={p.photoUrl} />
                    <FollowPlayerName name={p.name} tagClassName="follow-card-name" sponsorClassName="follow-card-sponsor" />
                  </span>
                  <span className="follow-card-record">{recordLine(p.record)}</span>
                  <span className="follow-card-chevron" aria-hidden="true" />
                </div>
                <div className="follow-card-sub">
                  <span>{p.tournamentCount} tournament{p.tournamentCount === 1 ? '' : 's'} tracked</span>
                  <button
                    className="follow-unfollow-btn"
                    onClick={(e) => { e.stopPropagation(); unfollow(p.id); }}
                  >
                    Unfollow
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="follow-card-detail">
                  {profileLoading && <p className="follow-muted">Loading…</p>}
                  {!profileLoading && profile && (
                    profile.tournaments.length === 0 ? (
                      <p className="follow-muted">No tracked tournaments yet.</p>
                    ) : (
                      <div className="follow-detail-rows">
                        {profile.tournaments.map((t) => (
                          <div key={`${t.tournamentId}-${t.gameName}-${t.partner || 'solo'}`} className="follow-detail-row">
                            <TournamentLogo name={t.tournamentName} />
                            <span className="follow-row-name">{t.tournamentName}</span>
                            <span className="follow-row-game">{t.gameName}{t.partner ? ` · w/ ${t.partner}` : ''}</span>
                            <span className={`follow-row-result${
                              t.result === 'Champion' ? ' champion'
                                : t.result === 'No result recorded' ? ' none' : ''
                            }`}>
                              {t.result}
                            </span>
                            <span className="follow-row-date">
                              {t.date ? formatTournamentDateTime(t.date) : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Follow;
