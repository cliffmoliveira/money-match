const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db/db');
const { sendResetEmail } = require('./mailer');

const router = express.Router();

const TTL_MIN = Number(process.env.RESET_TOKEN_TTL_MINUTES || 60);
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5000';
const GENERIC = { message: 'If an account exists for that email, a password reset link has been sent.' };

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// Request a reset link. ALWAYS returns the same generic response so it can't be
// used to probe which emails are registered. Relies on the global express.json.
router.post('/forgot-password', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  try {
    const user = await db.getAsync('SELECT id, email FROM users WHERE lower(email) = ?', [email]);
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + TTL_MIN * 60 * 1000).toISOString();
      await db.runAsync(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)`,
        [user.id, hashToken(rawToken), expiresAt, now.toISOString()]
      );
      const link = `${APP_BASE_URL}/reset-password?token=${rawToken}`;
      await sendResetEmail(user.email, link);
    }
    return res.status(200).json(GENERIC);
  } catch (err) {
    console.error('forgot-password error:', err.message);
    return res.status(500).json({ error: 'Could not process the request.' });
  }
});

// Complete the reset: validate the token, set a new bcrypt password, burn tokens.
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required.' });
  if (String(newPassword).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const row = await db.getAsync(
      `SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = ?`,
      [hashToken(String(token))]
    );
    if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }
    const hash = await bcrypt.hash(String(newPassword), 10);
    await db.runAsync('UPDATE users SET password = ? WHERE id = ?', [hash, row.user_id]);
    // Burn this token and any other outstanding ones for the same user.
    await db.runAsync('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?', [row.user_id]);
    return res.status(200).json({ message: 'Your password has been updated. You can now log in.' });
  } catch (err) {
    console.error('reset-password error:', err.message);
    return res.status(500).json({ error: 'Could not reset the password.' });
  }
});

module.exports = router;
