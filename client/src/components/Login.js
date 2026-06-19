import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './Login.css';
import logo from '../assets/images/MoneyMatch.png';

const Login = ({ setIsLoggedIn }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

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
        navigate('/future-tournaments');
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
      <img src={logo} alt="Money Match" className="login-logo" />
      <h2>Welcome back</h2>
      <p className="tagline">Play-money betting on the FGC.</p>

      <div className="auth-toggle">
        <button type="button" className="active">Log in</button>
        <button type="button" onClick={() => navigate('/signup')}>Sign up</button>
      </div>

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
        <input
          id="login-password"
          type="password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
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
