import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import './Navbar.css';
import logo from '../assets/images/MoneyMatch.png';

const Navbar = ({ isLoggedIn }) => {
  const [userName, setUserName] = useState('');
  const [balanceCents, setBalanceCents] = useState(null);

  useEffect(() => {
    const storedUserName = localStorage.getItem('username');
    if (storedUserName) {
      setUserName(storedUserName);
    }
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
        if (res.ok && active) {
          const data = await res.json();
          setBalanceCents(data.balanceCents);
        }
      } catch { /* ignore transient errors */ }
    };
    load();
    const id = setInterval(load, 20000);
    return () => { active = false; clearInterval(id); };
  }, [isLoggedIn]);

  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <nav className="navbar">
      <div className="navbar-inner">
        {/* Logo Section */}
        <div className="navbar-logo">
          <NavLink to="/">
            <img
              src={logo}
              alt="Money Match Logo"
              className="navbar-logo-img"
            />
          </NavLink>
        </div>

        {/* Mobile Toggle */}
        <button
          className={`navbar-toggle ${menuOpen ? 'open' : ''}`}
          aria-label="Toggle menu"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <span></span>
          <span></span>
          <span></span>
        </button>

        {/* Navigation Links */}
        <ul className={`navbar-links ${menuOpen ? 'open' : ''}`}>
          <li>
            <NavLink to="/past-results" className={({ isActive }) => isActive ? 'active' : ''} onClick={() => setMenuOpen(false)}>
              Past Results
            </NavLink>
          </li>
          <li>
            <NavLink to="/future-tournaments" className={({ isActive }) => isActive ? 'active' : ''} onClick={() => setMenuOpen(false)}>
              Future Tournaments
            </NavLink>
          </li>
          <li>
            <NavLink to="/live" className={({ isActive }) => isActive ? 'active' : ''} onClick={() => setMenuOpen(false)}>
              Live Betting
            </NavLink>
          </li>
        </ul>

        {/* Username Section */}
        <div className="navbar-username">
          {isLoggedIn ? (
            <>
              {balanceCents !== null && (
                <span className="navbar-balance">${(balanceCents / 100).toFixed(2)}</span>
              )}
              <span>Welcome, {userName || 'User'}</span>
              <button
                onClick={() => {
                  localStorage.removeItem('authToken');
                  localStorage.removeItem('username');
                  window.location.href = '/login';
                }}
                className="navbar-logout-button"
              >
                Logout
              </button>
            </>
          ) : (
            <NavLink to="/login" className="navbar-login-link" onClick={() => setMenuOpen(false)}>Login</NavLink>
          )}
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
