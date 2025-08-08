import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Navbar.css';
import logo from '../assets/images/MoneyMatch.png';

const Navbar = ({ isLoggedIn }) => {
  const [userName, setUserName] = useState('');

  useEffect(() => {
    const storedUserName = localStorage.getItem('username');
    console.log('Stored Username:', storedUserName); // Debugging log

    if (storedUserName) {
      setUserName(storedUserName);
    }
  }, [isLoggedIn]);

  return (
    <nav className="navbar">
      {/* Logo Section */}
      <div className="navbar-logo">
        <Link to="/">
          <img
            src={logo}
            alt="Money Match Logo"
            className="navbar-logo-img"
          />
        </Link>
      </div>

      {/* Navigation Links */}
      <ul className="navbar-links">
        <li><Link to="/past-results">Past Results</Link></li>
        <li><Link to="/future-tournaments">Future Tournaments</Link></li>
        <li><Link to="/startgg">Start.gg Tournaments</Link></li>
        <li><Link to="/startgg-past">Start.gg Winners</Link></li>
      </ul>

      {/* Username Section */}
      <div className="navbar-username">
        {isLoggedIn ? (
          <>
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
          <Link to="/login" className="navbar-login-link">Login</Link>
        )}
      </div>
    </nav>
  );
};

export default Navbar;
