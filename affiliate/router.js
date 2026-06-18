const express = require('express');
const config = require('./config');
const repo = require('./repo');
const { newId } = require('./ids');
const { resolveRegion } = require('./region');

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

module.exports = router;
