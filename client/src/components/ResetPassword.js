import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import './Login.css';
import logo from '../assets/images/MoneyMatch.png';
import PasswordInput from './PasswordInput';

const ResetPassword = () => {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-container">
      <img src={logo} alt="Money Match" className="login-logo" />

      {done ? (
        <>
          <h2>Password updated</h2>
          <p className="tagline">You can now log in with your new password.</p>
          <button type="button" onClick={() => navigate('/login')}>Go to log in</button>
        </>
      ) : !token ? (
        <>
          <h2>Reset your password</h2>
          <p className="error-message">This reset link is missing its token. Request a new one.</p>
          <button type="button" onClick={() => navigate('/forgot-password')}>Request a reset link</button>
        </>
      ) : (
        <>
          <h2>Choose a new password</h2>
          <p className="tagline">Set a new password for your account.</p>
          <form onSubmit={submit}>
            <label htmlFor="rp-pw">New password</label>
            <PasswordInput
              id="rp-pw"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
            <label htmlFor="rp-pw2">Confirm password</label>
            <PasswordInput
              id="rp-pw2"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
            <button type="submit" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>
          </form>
          {error && <p className="error-message">{error}</p>}
        </>
      )}
    </div>
  );
};

export default ResetPassword;
