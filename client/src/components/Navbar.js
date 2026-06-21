import React, { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import './Navbar.css';
import logo from '../assets/images/MoneyMatch.png';
import { fm } from '../utils/money';
import { apiFetch } from '../utils/api';

// Person outline shown in the avatar circle when no photo is uploaded.
const PersonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

// Icons for the mobile bottom tab bar (lucide-style; inherit color via currentColor).
const IconHome = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9.5 12 3l9 6.5" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" /></svg>
);
const IconLive = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
);
const IconFutures = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></svg>
);
const IconResults = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" /><path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" /><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" /><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" /></svg>
);
const IconRanks = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="6" y1="20" x2="6" y2="14" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="10" /></svg>
);

// Single source of truth for the primary destinations — rendered both as
// the desktop link row and the mobile bottom tab bar.
const NAV = [
  { to: '/', label: 'Home', end: true, icon: IconHome },
  { to: '/live', label: 'Live', icon: IconLive, live: true },
  { to: '/future-tournaments', label: 'Futures', icon: IconFutures },
  { to: '/past-results', label: 'Results', icon: IconResults },
  { to: '/leaderboard', label: 'Ranks', icon: IconRanks },
];

// Mirrors economy.js DAILY_BONUS_RAMP; only used if the API omits `ramp`.
const DEFAULT_RAMP = [2500, 5000, 7500, 10000, 12500, 15000, 20000];
// Tomorrow's reward given the streak just completed (days claimed incl. today).
const nextDayAmount = (ramp, streak) => {
  const r = (ramp && ramp.length) ? ramp : DEFAULT_RAMP;
  return r[Math.min(Math.max(streak, 0), r.length - 1)];
};

// Daily-reward popover: explains Fight Money, shows the 7-day streak ladder with
// today highlighted, and either claims the waiting bonus or previews tomorrow's.
const RewardPopover = ({ dailyBonus, claiming, onClaim }) => {
  const ramp = (dailyBonus.ramp && dailyBonus.ramp.length) ? dailyBonus.ramp : DEFAULT_RAMP;
  const N = ramp.length;
  const available = dailyBonus.available;
  // Filled cells = consecutive days already claimed; active = the cell claimable
  // now. When available, today's claim is day `day`, so `day - 1` are filled.
  const claimedDays = available ? Math.max(0, dailyBonus.day - 1) : (dailyBonus.currentStreak || 0);
  const activeDay = available ? dailyBonus.day : null;
  const streakDay = available ? dailyBonus.day : (dailyBonus.currentStreak || 0);
  const tomorrow = nextDayAmount(ramp, dailyBonus.currentStreak || 0);
  // Derive the claimed amount from the streak + ladder (not a stored field) so
  // it survives the periodic wallet refetch overwriting `dailyBonus`.
  const claimedAmount = ramp[Math.min(Math.max(streakDay, 1), N) - 1];

  return (
    <div className="reward-popover" role="dialog" aria-label="Daily reward">
      <div className="reward-pop-title">🎁 Daily Reward</div>
      <p className="reward-pop-blurb">
        <strong>Fight Money</strong> is your virtual-currency bankroll for betting.
      </p>

      {available ? (
        <div className="reward-pop-status">Day {streakDay} login streak{streakDay > 1 ? ' 🔥' : ''}</div>
      ) : (
        <div className="reward-pop-status reward-claimed">
          Claimed today ✓ +{fm(claimedAmount)}{streakDay > 0 ? ` · Day ${streakDay} 🔥` : ''}
        </div>
      )}

      <div className="reward-streak" role="list" aria-label="7-day streak ladder">
        {ramp.map((amt, i) => {
          const day = i + 1;
          // The claimable cell is clamped to the last column, and takes priority
          // over "filled" so a >7-day streak still highlights the Day-7+ reward.
          const activeIdx = activeDay != null ? Math.min(activeDay, N) : null;
          const isActive = activeIdx != null && day === activeIdx;
          const filled = day <= Math.min(claimedDays, N) && !isActive;
          return (
            <div key={day} role="listitem"
              className={`reward-cell${filled ? ' filled' : ''}${isActive ? ' active' : ''}`}>
              <span className="reward-cell-day">{day}{day === N ? '+' : ''}</span>
              <span className="reward-cell-amt">{Math.round(amt / 100)}</span>
            </div>
          );
        })}
      </div>

      {available ? (
        <button className="reward-claim-btn" onClick={onClaim} disabled={claiming}>
          {claiming ? 'Claiming…' : `Claim +${fm(dailyBonus.amountCents)}`}
        </button>
      ) : (
        <div className="reward-next">Come back tomorrow for <strong>+{fm(tomorrow)}</strong></div>
      )}

      <div className="reward-earn">Earn more: win bets · log in daily</div>
    </div>
  );
};

const Navbar = ({ isLoggedIn }) => {
  const [userName, setUserName] = useState('');
  const [avatar, setAvatar] = useState(null);
  const [balanceCents, setBalanceCents] = useState(null);
  const [points, setPoints] = useState(null);
  const [dailyBonus, setDailyBonus] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [rewardOpen, setRewardOpen] = useState(false);
  const accountRef = useRef(null);
  const rewardRef = useRef(null);
  const autoOpenedRef = useRef(false);
  const walletSeqRef = useRef(0); // guards against a stale wallet poll clobbering a fresh claim

  useEffect(() => {
    const read = () => { const u = localStorage.getItem('username'); if (u) setUserName(u); };
    // Pull the avatar from the account (the only place it lives).
    const loadAvatar = async () => {
      const userId = localStorage.getItem('userId');
      if (!isLoggedIn || !userId) { setAvatar(null); return; }
      try {
        const res = await apiFetch(`/api/account?userId=${userId}`);
        if (res.ok) setAvatar((await res.json()).avatar || null);
      } catch { /* ignore */ }
    };
    const refresh = () => { read(); loadAvatar(); };
    refresh();
    // Refresh the greeting + avatar immediately when the account page saves.
    window.addEventListener('mm-user-updated', refresh);
    return () => window.removeEventListener('mm-user-updated', refresh);
  }, [isLoggedIn]);

  // Keep the wallet badge fresh while logged in.
  useEffect(() => {
    if (!isLoggedIn) { setBalanceCents(null); setPoints(null); return; }
    const userId = localStorage.getItem('userId');
    if (!userId) return;
    let active = true;
    const load = async () => {
      // A claim (or a newer poll) bumps walletSeqRef; a stale in-flight response
      // then no longer matches and is dropped, so it can't revert a just-claimed
      // bonus back to "available".
      const seq = ++walletSeqRef.current;
      try {
        const res = await apiFetch(`/api/wallet?userId=${userId}`);
        if (res.ok && active) {
          const data = await res.json();
          if (active && seq === walletSeqRef.current) {
            setBalanceCents(data.balanceCents);
            setDailyBonus(data.dailyBonus || null);
          }
        }
      } catch { /* ignore transient errors */ }
      try {
        const pr = await apiFetch(`/api/pickem/profile?userId=${userId}`);
        if (pr.ok && active) {
          const p = await pr.json();
          setPoints(typeof p.points === 'number' ? p.points : 0);
        }
      } catch { /* ignore transient errors */ }
    };
    load();
    const id = setInterval(load, 20000);
    return () => { active = false; clearInterval(id); };
  }, [isLoggedIn]);

  // Close the account menu when clicking outside it.
  useEffect(() => {
    if (!accountOpen) return;
    const onDocClick = (e) => {
      if (accountRef.current && !accountRef.current.contains(e.target)) setAccountOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [accountOpen]);

  // Close the reward popover when clicking outside it.
  useEffect(() => {
    if (!rewardOpen) return;
    const onDocClick = (e) => {
      if (rewardRef.current && !rewardRef.current.contains(e.target)) setRewardOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [rewardOpen]);

  // Auto-open the reward popover once per session when a bonus is waiting, so a
  // first-time user learns what Fight Money is and why they're getting it.
  useEffect(() => {
    if (!dailyBonus?.available || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    if (sessionStorage.getItem('mm-reward-autoopened') === '1') return;
    sessionStorage.setItem('mm-reward-autoopened', '1');
    setRewardOpen(true);
  }, [dailyBonus?.available]);

  // Claim the free daily Fight Money bonus (login streak), then refresh the badge.
  const claimDaily = async () => {
    const userId = localStorage.getItem('userId');
    if (!userId || claiming) return;
    setClaiming(true);
    try {
      const res = await apiFetch('/api/wallet/daily-bonus', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        // Invalidate any in-flight wallet poll that read pre-claim state, so a
        // late response can't flip the popover back to "available".
        walletSeqRef.current++;
        if (data.balanceCents != null) setBalanceCents(data.balanceCents);
        // Flip the popover to its claimed state in place (keep it open so the
        // user sees the confirmation + tomorrow's preview). The server returns the
        // authoritative streak on BOTH claimed and already-claimed responses, so
        // trust it; currentStreak drives the "claimed +X" amount and tomorrow's.
        setDailyBonus((b) => b ? {
          ...b,
          available: false,
          currentStreak: data.streak ?? b.currentStreak,
        } : b);
      }
    } catch { /* ignore */ } finally {
      setClaiming(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('username');
    localStorage.removeItem('userId');
    window.location.href = '/login';
  };

  const linkClass = ({ isActive }) => (isActive ? 'active' : '');
  const tabClass = ({ isActive }) => (isActive ? 'tabbar-item active' : 'tabbar-item');

  return (
    <>
      <nav className="navbar">
        <div className="navbar-inner">
          <div className="navbar-logo">
            <NavLink to="/"><img src={logo} alt="Money Match Logo" className="navbar-logo-img" /></NavLink>
          </div>

          {/* Primary links — desktop only (mobile uses the bottom tab bar) */}
          <ul className="navbar-links">
            {NAV.map(({ to, label, end, live }) => (
              <li key={to}>
                <NavLink to={to} end={end} className={linkClass}>
                  {live && <span className="live-dot"></span>}{label}
                </NavLink>
              </li>
            ))}
          </ul>

          {/* Account / wallet */}
          <div className="navbar-username">
            {isLoggedIn ? (
              <>
                {balanceCents !== null && (
                  <span className="navbar-balance" title="Fight Money — virtual currency">{fm(balanceCents)}</span>
                )}
                {points !== null && (
                  <span className="navbar-points" title="Ranked points — your Picks score">
                    {points.toLocaleString()} <span className="navbar-points-label">pts</span>
                  </span>
                )}
                {dailyBonus && (
                  <div className="navbar-reward" ref={rewardRef}>
                    <button
                      type="button"
                      className={`navbar-reward-trigger${dailyBonus.available ? ' has-claim' : ''}`}
                      onClick={() => setRewardOpen((o) => !o)}
                      title="Daily reward — how you earn Fight Money"
                      aria-haspopup="dialog"
                      aria-expanded={rewardOpen}
                    >
                      <span className="navbar-reward-gift" aria-hidden="true">🎁</span>
                      <span className="navbar-reward-label">Daily reward</span>
                      {dailyBonus.available && <span className="navbar-reward-dot" aria-hidden="true" />}
                    </button>
                    {rewardOpen && (
                      <RewardPopover dailyBonus={dailyBonus} claiming={claiming} onClaim={claimDaily} />
                    )}
                  </div>
                )}
                {userName && <span className="navbar-displayname" title={userName}>{userName}</span>}
                <div className="navbar-account" ref={accountRef}>
                  <button
                    className="navbar-avatar"
                    onClick={() => setAccountOpen((o) => !o)}
                    title={userName ? `Account · ${userName}` : 'Account'}
                    aria-label="Account menu"
                    aria-haspopup="menu"
                    aria-expanded={accountOpen}
                  >
                    {avatar
                      ? <img src={avatar} alt="" className="navbar-avatar-img" />
                      : <PersonIcon />}
                  </button>
                  {accountOpen && (
                    <div className="account-menu" role="menu">
                      {userName && <div className="account-menu-name">{userName}</div>}
                      <NavLink to="/account" className="account-menu-item" role="menuitem" onClick={() => setAccountOpen(false)}>Account &amp; profile</NavLink>
                      <NavLink to="/profile" className="account-menu-item" role="menuitem" onClick={() => setAccountOpen(false)}>My Picks</NavLink>
                      <button className="account-menu-item" role="menuitem" onClick={logout}>Log out</button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <NavLink to="/login" className="navbar-login-link">Login</NavLink>
            )}
          </div>
        </div>
      </nav>

      {/* Mobile bottom tab bar — primary navigation, thumb-reachable */}
      <nav className="mobile-tabbar" aria-label="Primary">
        {NAV.map(({ to, label, end, icon, live }) => (
          <NavLink key={to} to={to} end={end} className={tabClass}>
            <span className="tabbar-icon">{icon}{live && <span className="tabbar-live-dot"></span>}</span>
            <span className="tabbar-label">{label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
};

export default Navbar;
