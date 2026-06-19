import React, { useState } from 'react';

// Eye / eye-off icons (lucide-style; inherit color via currentColor).
const EyeIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOffIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.7 5.1A11 11 0 0 1 12 5c6.5 0 10 7 10 7a13.3 13.3 0 0 1-2.2 2.9" />
    <path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 5.4-1.4" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m2 2 20 20" />
  </svg>
);

// Password input with a show/hide visibility toggle. Drop-in replacement for a
// <input type="password"> inside the .login-container forms.
const PasswordInput = ({ id, name, value, onChange, placeholder = '••••••••', autoComplete, required }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="password-field">
      <input
        id={id}
        name={name}
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        required={required}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
        title={show ? 'Hide password' : 'Show password'}
      >
        {show ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  );
};

export default PasswordInput;
