import React, { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import './Navbar.css';
import logo from '../assets/images/MoneyMatch.png';
import DepositModal from './DepositModal';

const initials = (name) => (name || 'U').trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'U';

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

// Single source of truth for the four primary destinations — rendered both as
// the desktop link row and the mobile bottom tab bar.
const NAV = [
  { to: '/', label: 'Home', end: true, icon: IconHome },
  { to: '/live', label: 'Live', icon: IconLive, live: true },
  { to: '/future-tournaments', label: 'Futures', icon: IconFutures },
  { to: '/past-results', label: 'Results', icon: IconResults },
];

const Navbar = ({ isLoggedIn }) => {
  const [userName, setUserName] = useState('');
  const [balanceCents, setBalanceCents] = useState(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef(null);

  useEffect(() => {
    const storedUserName = localStorage.getItem('username');
    if (storedUserName) setUserName(storedUserName);
  }, [isLoggedIn]);

  // Keep the wallet badge fresh while logged in.
  useEffect(() => {
    if (!isLoggedIn) { setBalanceCents(null); return; }
    const userId = localStorage.getItem('userId');
    if (!userId) return;
    let active = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/wallet?userId=${userId}`);
        if (res.ok && active) setBalanceCents((await res.json()).balanceCents);
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

  // Play-money top-up: credit the wallet, refresh the badge.
  const addFunds = async (cents) => {
    const userId = localStorage.getItem('userId');
    const res = await fetch('/api/wallet/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: Number(userId), amountCents: cents }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Deposit failed');
    setBalanceCents((await res.json()).balanceCents);
  };

  const logout = () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('username');
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
                  <span className="navbar-balance">${(balanceCents / 100).toFixed(2)}</span>
                )}
                <button className="navbar-deposit" onClick={() => setDepositOpen(true)}>Deposit</button>
                <div className="navbar-account" ref={accountRef}>
                  <button
                    className="navbar-avatar"
                    onClick={() => setAccountOpen((o) => !o)}
                    title={userName ? `Account · ${userName}` : 'Account'}
                    aria-label="Account menu"
                    aria-haspopup="menu"
                    aria-expanded={accountOpen}
                  >
                    {initials(userName)}
                  </button>
                  {accountOpen && (
                    <div className="account-menu" role="menu">
                      {userName && <div className="account-menu-name">{userName}</div>}
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

      <DepositModal
        isOpen={depositOpen}
        onClose={() => setDepositOpen(false)}
        balanceCents={balanceCents}
        onConfirm={addFunds}
      />
    </>
  );
};

export default Navbar;
