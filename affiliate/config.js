// Reads affiliate env with sane dev defaults. One source of truth for config.
module.exports = {
  hmacSecret: process.env.AFFILIATE_HMAC_SECRET || 'dev-shared-secret-change-me',
  mockBookUrl: process.env.MOCK_BOOK_URL || 'http://localhost:4100',
  mockAffiliateId: process.env.MOCK_AFFILIATE_ID || 'mm-mock-01',
  devRegion: process.env.AFFILIATE_DEV_REGION || 'BR',
  windowDays: Number(process.env.ATTRIBUTION_WINDOW_DAYS || 30),
};
