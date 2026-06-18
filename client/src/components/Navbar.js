import React, { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import './Navbar.css';
import logo from '../assets/images/MoneyMatch.png';
import DepositModal from './DepositModal';

const initials = (name) => (name || 'U').trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'U';

const Navbar = ({ isLoggedIn }) => {
  const [userName, setUserName] = useState('');
  const [balanceCents, setBalanceCents] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
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

  const close = () => setMenuOpen(false);
  const linkClass = ({ isActive }) => (isActive ? 'active' : '');

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <div className="navbar-logo">
          <NavLink to="/"><img src={logo} alt="Money Match Logo" className="navbar-logo-img" /></NavLink>
        </div>

        {/* Mobile Toggle */}
        <button
          className={`navbar-toggle ${menuOpen ? 'open' : ''}`}
          aria-label="Toggle menu"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <span></span><span></span><span></span>
        </button>

        {/* Navigation Links (routes unchanged; labels match the redesign) */}
        <ul className={`navbar-links ${menuOpen ? 'open' : ''}`}>
          <li><NavLink to="/" end className={linkClass} onClick={close}>Home</NavLink></li>
          <li>
            <NavLink to="/live" className={linkClass} onClick={close}>
              <span className="live-dot"></span>Live
            </NavLink>
          </li>
          <li><NavLink to="/future-tournaments" className={linkClass} onClick={close}>Futures</NavLink></li>
          <li><NavLink to="/past-results" className={linkClass} onClick={close}>Results</NavLink></li>
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
            <NavLink to="/login" className="navbar-login-link" onClick={close}>Login</NavLink>
          )}
        </div>
      </div>

      <DepositModal
        isOpen={depositOpen}
        onClose={() => setDepositOpen(false)}
        balanceCents={balanceCents}
        onConfirm={addFunds}
      />
    </nav>
  );
};

export default Navbar;
