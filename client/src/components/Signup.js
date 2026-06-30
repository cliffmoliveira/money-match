import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './Login.css';
import logo from '../assets/images/hit_confirmed.png';
import PasswordInput from './PasswordInput';

const Signup = () => {
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const navigate = useNavigate();

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const data = await response.json();

      if (response.ok) {
        setSuccess('Account created successfully! Redirecting to login...');
        setTimeout(() => navigate('/login'), 3000); // Redirect after 3 seconds
      } else {
        setError(data.error || 'Failed to create account.');
      }
    } catch (err) {
      console.error('Signup error:', err);
      setError('An error occurred. Please try again later.');
    }
  };

  return (
    <div className="login-container">
      <img src={logo} alt="Hit Confirmed" className="login-logo" />
      <h2>Create your account</h2>
      <p className="tagline">Virtual-currency picks on the FGC.</p>

      <div className="auth-toggle">
        <button type="button" onClick={() => navigate('/login')}>Log in</button>
        <button type="button" className="active">Sign up</button>
      </div>

      <form onSubmit={handleSubmit}>
        <label htmlFor="signup-username">Display name</label>
        <input
          id="signup-username"
          type="text"
          name="username"
          value={form.username}
          onChange={handleChange}
          required
        />
        <label htmlFor="signup-email">Email</label>
        <input
          id="signup-email"
          type="email"
          name="email"
          placeholder="you@example.com"
          value={form.email}
          onChange={handleChange}
          required
        />
        <label htmlFor="signup-password">Password</label>
        <PasswordInput
          id="signup-password"
          name="password"
          value={form.password}
          onChange={handleChange}
          required
          autoComplete="new-password"
        />
        <button type="submit">Create account</button>
      </form>
      {error && <p className="error-message">{error}</p>}
      {success && <p className="success">{success}</p>}
    </div>
  );
};

export default Signup;
