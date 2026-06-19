import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './Login.css';
import logo from '../assets/images/MoneyMatch.png';

const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-container">
      <img src={logo} alt="Money Match" className="login-logo" />
      <h2>Reset your password</h2>
      <p className="tagline">We'll email you a reset link.</p>

      {sent ? (
        <>
          <p className="reset-note">
            If an account exists for <b>{email}</b>, a password reset link has been sent. Check your
            inbox (and the server console in dev).
          </p>
          <button type="button" onClick={() => navigate('/login')}>Back to log in</button>
        </>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="fp-email">Email</label>
          <input
            id="fp-email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}

      {error && <p className="error-message">{error}</p>}

      {!sent && (
        <p className="forgot-link">
          <a href="/login" onClick={(e) => { e.preventDefault(); navigate('/login'); }}>Back to log in</a>
        </p>
      )}
    </div>
  );
};

export default ForgotPassword;
