const nodemailer = require('nodemailer');

// SMTP transport from env. Returns null if SMTP isn't configured, in which case
// the caller logs the reset link instead of sending — so the flow works before
// real credentials are wired, and starts emailing the moment SMTP_* are set.
function makeTransport() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const FROM = process.env.MAIL_FROM || 'Hit Confirmed <no-reply@hitconfirmed.local>';
const TTL_MIN = Number(process.env.RESET_TOKEN_TTL_MINUTES || 60);

async function sendResetEmail(to, link) {
  const subject = 'Reset your Hit Confirmed password';
  const text =
    `We received a request to reset your Hit Confirmed password.\n\n` +
    `Reset it here (valid for ${TTL_MIN} minutes):\n${link}\n\n` +
    `If you didn't request this, you can safely ignore this email.`;
  const html =
    `<p>We received a request to reset your Hit Confirmed password.</p>` +
    `<p><a href="${link}">Reset your password</a> (valid for ${TTL_MIN} minutes).</p>` +
    `<p style="color:#888;font-size:13px">If you didn't request this, you can safely ignore this email.</p>`;

  const transport = makeTransport();
  if (!transport) {
    // No SMTP configured — log the link so the reset flow still works locally.
    console.log(`\n[password-reset] SMTP not configured; reset link for ${to}:\n  ${link}\n`);
    return { delivered: false, logged: true };
  }
  await transport.sendMail({ from: FROM, to, subject, text, html });
  return { delivered: true };
}

module.exports = { sendResetEmail };
