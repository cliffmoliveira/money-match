import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './AccountSettings.css';
import { apiFetch } from '../utils/api';

const GENDERS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];
const PRONOUNS = ['he/him', 'she/her', 'they/them'];

const EMPTY = {
  display_name: '', full_name: '', birthday: '', gender: '', pronouns: '',
  country: '', team: '', favorite_game: '', main_character: '', bio: '',
  twitch: '', twitter: '', discord: '', avatar: '',
};

// Person outline shown when no avatar is uploaded.
const PersonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

// Resize/crop an uploaded image to a small square JPEG data URL so the avatar
// stays a few KB and never carries an SVG/script payload.
function fileToAvatarDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a valid image.'));
      img.onload = () => {
        const SIZE = 256;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(SIZE / img.width, SIZE / img.height); // cover
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const AccountSettings = () => {
  const navigate = useNavigate();
  const userId = localStorage.getItem('userId');
  const [form, setForm] = useState(null); // null while loading
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!userId) return;
    apiFetch(`/api/account?userId=${userId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load'))))
      .then((a) => {
        setHandle(a.username || '');
        setEmail(a.email || '');
        const next = { ...EMPTY };
        for (const k of Object.keys(EMPTY)) next[k] = a[k] || '';
        setForm(next);
      })
      .catch(() => setError('Could not load your account.'));
  }, [userId]);

  const set = (k) => (e) => {
    const v = e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
    setSuccess(false);
    setError(null);
  };

  const onAvatarFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // let the same file be re-picked later
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      setError('Please choose a PNG, JPEG, WebP, or GIF image.');
      return;
    }
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      setForm((f) => ({ ...f, avatar: dataUrl }));
      setSuccess(false); setError(null);
    } catch (err) {
      setError(err.message);
    }
  };
  const removeAvatar = () => { setForm((f) => ({ ...f, avatar: '' })); setSuccess(false); setError(null); };

  const submit = async (e) => {
    e.preventDefault();
    if (!form) return;
    if (!form.display_name.trim()) { setError('Display name is required.'); return; }
    setSaving(true); setError(null); setSuccess(false);
    try {
      const res = await apiFetch('/api/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save your changes.');
      // Keep the navbar greeting + public name in sync immediately.
      localStorage.setItem('username', data.display_name || form.display_name.trim());
      window.dispatchEvent(new Event('mm-user-updated'));
      setSuccess(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!userId) { navigate('/login'); return null; }
  if (!form) {
    return (
      <div className="account-page">
        <p className="account-loading">{error || 'Loading your account…'}</p>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="account-page">
      <div className="account-head">
        <h1>Account &amp; profile</h1>
        <p className="account-sub">@{handle}{email ? ` · ${email}` : ''}</p>
      </div>

      <form className="account-form" onSubmit={submit}>
        <section className="account-section">
          <h2>Photo</h2>
          <div className="account-avatar-row">
            <div className="account-avatar-preview">
              {form.avatar ? <img src={form.avatar} alt="Your avatar" /> : <PersonIcon />}
            </div>
            <div className="account-avatar-actions">
              <label className="account-avatar-upload">
                {form.avatar ? 'Change photo' : 'Upload photo'}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onAvatarFile} hidden />
              </label>
              {form.avatar && (
                <button type="button" className="account-avatar-remove" onClick={removeAvatar}>Remove</button>
              )}
              <p className="account-avatar-hint">Square images look best. With no photo, a person icon is shown.</p>
            </div>
          </div>
        </section>

        <section className="account-section">
          <h2>Identity</h2>
          <label className="account-field">
            <span>Display name <em className="req">required</em></span>
            <input type="text" value={form.display_name} onChange={set('display_name')}
              maxLength={30} placeholder="How you appear on leaderboards" required />
          </label>
          <label className="account-field">
            <span>Full name</span>
            <input type="text" value={form.full_name} onChange={set('full_name')} maxLength={80} placeholder="Optional" />
          </label>
        </section>

        <section className="account-section">
          <h2>About you</h2>
          <div className="account-row">
            <label className="account-field">
              <span>Birthday</span>
              <input type="date" value={form.birthday} onChange={set('birthday')} max={today} />
            </label>
            <label className="account-field">
              <span>Country</span>
              <input type="text" value={form.country} onChange={set('country')} maxLength={56} placeholder="Optional" />
            </label>
          </div>
          <div className="account-row">
            <label className="account-field">
              <span>Gender</span>
              <input list="acct-genders" value={form.gender} onChange={set('gender')} maxLength={30} placeholder="Optional" />
              <datalist id="acct-genders">{GENDERS.map((g) => <option key={g} value={g} />)}</datalist>
            </label>
            <label className="account-field">
              <span>Pronouns</span>
              <input list="acct-pronouns" value={form.pronouns} onChange={set('pronouns')} maxLength={30} placeholder="Optional" />
              <datalist id="acct-pronouns">{PRONOUNS.map((p) => <option key={p} value={p} />)}</datalist>
            </label>
          </div>
        </section>

        <section className="account-section">
          <h2>Fighting game</h2>
          <div className="account-row">
            <label className="account-field">
              <span>Favorite game</span>
              <input type="text" value={form.favorite_game} onChange={set('favorite_game')} maxLength={60} placeholder="e.g. Street Fighter 6" />
            </label>
            <label className="account-field">
              <span>Main</span>
              <input type="text" value={form.main_character} onChange={set('main_character')} maxLength={60} placeholder="e.g. Cammy" />
            </label>
          </div>
          <label className="account-field">
            <span>Team / sponsor</span>
            <input type="text" value={form.team} onChange={set('team')} maxLength={40} placeholder="Optional" />
          </label>
        </section>

        <section className="account-section">
          <h2>Bio</h2>
          <label className="account-field">
            <span>About you <em>{form.bio.length}/280</em></span>
            <textarea value={form.bio} onChange={set('bio')} maxLength={280} rows={3} placeholder="A short intro — playstyle, accolades, trash talk…" />
          </label>
        </section>

        <section className="account-section">
          <h2>Socials</h2>
          <div className="account-row">
            <label className="account-field"><span>Twitch</span>
              <input type="text" value={form.twitch} onChange={set('twitch')} maxLength={40} placeholder="username" /></label>
            <label className="account-field"><span>X / Twitter</span>
              <input type="text" value={form.twitter} onChange={set('twitter')} maxLength={40} placeholder="username" /></label>
            <label className="account-field"><span>Discord</span>
              <input type="text" value={form.discord} onChange={set('discord')} maxLength={40} placeholder="username" /></label>
          </div>
        </section>

        {error && <p className="account-error">{error}</p>}
        {success && <p className="account-success">Saved — your profile is up to date.</p>}

        <div className="account-actions">
          <button type="submit" className="account-save" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default AccountSettings;
