const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const express = require('express');
const sign = require('./hmac');

const PORT = Number(process.env.PORT || 4100);
const POSTBACK_URL = process.env.MONEY_MATCH_POSTBACK_URL || 'http://localhost:5000/api/affiliate/postback';
const SECRET = process.env.MOCK_BOOK_HMAC_SECRET || 'dev-shared-secret-change-me';

const app = express();
app.use(express.urlencoded({ extended: true }));

let lastPostback = null; // { body, sig } — for the "Resend" affordance

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Deep-link landing: echo EVERY received tracking param (the verification window).
app.get('/bet', (req, res) => {
  const q = req.query;
  const rows = Object.entries(q).map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`).join('');
  res.send(`<!doctype html><meta charset="utf-8"><title>Mock Book</title>
  <h1>Mock Sportsbook — bet landing</h1>
  <p>Tracking params received via the deep link:</p>
  <table border=1 cellpadding=6>${rows}</table>
  <form method="post" action="/confirm">
    ${Object.entries(q).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
    <p><button type="submit">Confirm bet</button></p>
  </form>
  <form method="post" action="/resend"><button type="submit">Resend last postback</button></form>`);
});

async function send(body, sig) {
  lastPostback = { body, sig };
  const r = await fetch(POSTBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MM-Signature': sig }, body });
  return { status: r.status, text: await r.text() };
}

// Build -> sign -> real cross-origin S2S postback to Money Match.
app.post('/confirm', async (req, res) => {
  const q = req.body;
  const payload = {
    book: q.book || 'mock_book',
    click_id: q.click_id,
    external_ref: `mockbook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversion_type: 'first_time_deposit',
    amount: 5000, currency: 'BRL',
    commission_model: 'cpa', commission_value: 12000,
  };
  const body = JSON.stringify(payload);
  const sig = sign(Buffer.from(body), SECRET);
  const out = await send(body, sig);
  res.send(`<h1>Postback sent</h1><p>Money Match responded <b>${out.status}</b>: <code>${esc(out.text)}</code></p>
    <p>external_ref: <code>${esc(payload.external_ref)}</code></p><a href="javascript:history.back()">back</a>`);
});

// Resend the EXACT last signed bytes — demonstrates the idempotent/dedupe path.
app.post('/resend', async (req, res) => {
  if (!lastPostback) return res.send('<p>No postback sent yet.</p>');
  const out = await send(lastPostback.body, lastPostback.sig);
  res.send(`<h1>Resent identical postback</h1><p>Money Match responded <b>${out.status}</b>: <code>${esc(out.text)}</code></p>`);
});

app.listen(PORT, () => console.log(`Mock book on http://localhost:${PORT}`));
