import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import './Login.css';
import logo from '../assets/images/hit_confirmed.png';
import PasswordInput from './PasswordInput';

const Login = ({ setIsLoggedIn }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  // apiFetch redirects here with ?expired=1 when it catches a 401 from a
  // token we thought was still valid (see client/src/utils/api.js) - explain
  // why they landed back on the login screen instead of leaving it a mystery.
  const [searchParams] = useSearchParams();
  const sessionExpired = searchParams.get('expired') === '1';

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (response.ok) {
        localStorage.setItem('authToken', data.token);
        localStorage.setItem('userId', data.userId);
        localStorage.setItem('username', data.username); // Store username instead of userId
        setIsLoggedIn(true);
        navigate('/');
      } else {
        setError(data.error || 'Login failed.');
      }
    } catch (err) {
      console.error('Login error:', err);
      setError('An error occurred. Please try again.');
    }
  };

  return (
    <div className="login-container">
      <img src={logo} alt="Hit Confirmed" className="login-logo" />
      <h2>Welcome back</h2>
      <p className="tagline">Virtual-currency picks on the FGC.</p>

      <div className="auth-toggle">
        <button type="button" className="active">Log in</button>
        <button type="button" onClick={() => navigate('/signup')}>Sign up</button>
      </div>

      {sessionExpired && (
        <p className="error-message">Your session expired — please log in again.</p>
      )}

      <form onSubmit={handleLogin}>
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="login-password">Password</label>
        <PasswordInput
          id="login-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button type="submit">Log in</button>
      </form>
      <p className="forgot-link">
        <a href="/forgot-password" onClick={(e) => { e.preventDefault(); navigate('/forgot-password'); }}>Forgot password?</a>
      </p>
      {error && <p className="error-message">{error}</p>}
    </div>
  );
};

export default Login;
