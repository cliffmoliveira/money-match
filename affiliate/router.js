const express = require('express');
const config = require('./config');
const repo = require('./repo');
const { newId } = require('./ids');
const { resolveRegion } = require('./region');
const { verify } = require('./hmac');
const { isWithinWindow } = require('./window');

const router = express.Router();

const REQUIRED = ['event_id', 'match_id', 'market_id', 'selection_id', 'participant_id', 'source_page'];
const SOURCE_PAGES = new Set(['home', 'live', 'futures', 'match_detail']);

router.post('/click', express.json(), async (req, res) => {
  const b = req.body || {};
  for (const k of REQUIRED) if (!b[k]) return res.status(400).json({ error: `missing ${k}` });
  if (!SOURCE_PAGES.has(b.source_page)) return res.status(400).json({ error: 'invalid source_page' });

  const click_id = newId();
  const region = resolveRegion(req);            // server-side; body.region ignored
  const book = b.book || 'mock_book';
  const affiliate_id = config.mockAffiliateId;

  const params = new URLSearchParams({
    click_id, affiliate_id, book,
    event_id: b.event_id, match_id: b.match_id, market_id: b.market_id,
    selection_id: b.selection_id, participant_id: b.participant_id,
  });
  const deep_link_url = `${config.mockBookUrl}/bet?${params.toString()}`;

  await repo.createClick({
    click_id, user_id: b.userId ?? null, region, book, affiliate_id,
    event_id: b.event_id, match_id: b.match_id, market_id: b.market_id,
    selection_id: b.selection_id, participant_id: b.participant_id,
    source_page: b.source_page, deep_link_url, created_at: new Date().toISOString(),
  });

  res.status(201).json({ click_id, deep_link_url });
});

const ACK = { received: true }; // uniform 200 ack - a duplicate is byte-identical

router.post('/postback', express.raw({ type: '*/*' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const received_at = new Date().toISOString();
  const remote_ip = req.ip;

  // 1) Persist raw FIRST, before any verify/parse.
  const logId = await repo.logPostback({ received_at, remote_ip, raw_payload: raw.toString('utf8') });

  // 2) Verify HMAC (constant-time) BEFORE parsing the body.
  const sigValid = verify(raw, req.get('X-MM-Signature'), config.hmacSecret);
  if (!sigValid) {
    await repo.setPostbackResult(logId, { signature_valid: false, outcome: 'rejected_signature' });
    return res.status(401).json({ error: 'invalid signature' });
  }

  // 3) Parse.
  let p;
  try { p = JSON.parse(raw.toString('utf8')); }
  catch {
    await repo.setPostbackResult(logId, { signature_valid: true, outcome: 'malformed' });
    return res.status(400).json({ error: 'malformed' });
  }
  const required = ['book', 'click_id', 'external_ref', 'conversion_type', 'currency'];
  for (const k of required) {
    if (p[k] == null) {
      await repo.setPostbackResult(logId, { signature_valid: true, outcome: 'malformed', book: p.book, external_ref: p.external_ref, click_id: p.click_id });
      return res.status(400).json({ error: `missing ${k}` });
    }
  }
  const ctx = { signature_valid: true, book: p.book, external_ref: p.external_ref, click_id: p.click_id };

  // 4) Resolve the click. Unknown / expired short-circuit (no conversion).
  const click = await repo.findClick(p.click_id);
  if (!click) { await repo.setPostbackResult(logId, { ...ctx, outcome: 'unmatched' }); return res.status(200).json(ACK); }
  if (!isWithinWindow(click.created_at, received_at, config.windowDays)) {
    await repo.setPostbackResult(logId, { ...ctx, outcome: 'expired' });
    return res.status(200).json(ACK);
  }

  // 5) Reconcile via an ATOMIC insert - the UNIQUE(book, external_ref) is the dedupe.
  try {
    await repo.insertConversion({
      conversion_id: newId(), postback_log_id: logId, click_id: p.click_id, book: p.book,
      external_ref: p.external_ref, conversion_type: p.conversion_type, amount: p.amount ?? null,
      currency: p.currency, commission_model: p.commission_model ?? null,
      commission_value: p.commission_value ?? null, received_at,
    });
  } catch (err) {
    if (repo.isUniqueViolation(err)) {
      await repo.setPostbackResult(logId, { ...ctx, outcome: 'duplicate' });
      return res.status(200).json(ACK);
    }
    throw err;
  }
  await repo.markClickConverted(p.click_id); // one click may convert many times; never blocks
  await repo.setPostbackResult(logId, { ...ctx, outcome: 'reconciled' });
  return res.status(200).json(ACK);
});

async function resolve(req, res, status) {
  await repo.resolveConversion(req.params.id, status, new Date().toISOString());
  res.status(200).json({ conversion_id: req.params.id, validation_status: status });
}
router.post('/conversions/:id/validate', (req, res) => resolve(req, res, 'validated'));
router.post('/conversions/:id/reject', (req, res) => resolve(req, res, 'rejected'));

module.exports = router;
