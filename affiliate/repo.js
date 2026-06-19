const db = require('../db/db');

const COLS = ['click_id','user_id','region','book','affiliate_id','event_id','match_id',
  'market_id','selection_id','participant_id','source_page','deep_link_url','created_at'];

async function createClick(c) {
  await db.runAsync(
    `INSERT INTO click_records (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`,
    COLS.map((k) => c[k])
  );
}
function findClick(clickId) {
  return db.getAsync(`SELECT * FROM click_records WHERE click_id = ?`, [clickId]);
}
async function markClickConverted(clickId) {
  await db.runAsync(`UPDATE click_records SET status = 'converted' WHERE click_id = ?`, [clickId]);
}

async function logPostback({ received_at, remote_ip, raw_payload }) {
  const stmt = await db.runAsync(
    `INSERT INTO postback_log (received_at, remote_ip, signature_valid, outcome, raw_payload)
     VALUES (?, ?, NULL, 'received', ?)`,
    [received_at, remote_ip, raw_payload]
  );
  return stmt.lastID;
}
async function setPostbackResult(id, { signature_valid, outcome, book, external_ref, click_id }) {
  await db.runAsync(
    `UPDATE postback_log SET signature_valid = ?, outcome = ?, book = ?, external_ref = ?, click_id = ? WHERE id = ?`,
    [signature_valid == null ? null : (signature_valid ? 1 : 0), outcome, book ?? null, external_ref ?? null, click_id ?? null, id]
  );
}

const CONV_COLS = ['conversion_id','postback_log_id','click_id','book','external_ref','conversion_type',
  'amount','currency','commission_model','commission_value','received_at'];
async function insertConversion(c) {
  // Atomic dedupe: rely on UNIQUE(book, external_ref). Caller catches the violation.
  await db.runAsync(
    `INSERT INTO conversion_records (${CONV_COLS.join(',')}) VALUES (${CONV_COLS.map(() => '?').join(',')})`,
    CONV_COLS.map((k) => c[k])
  );
}
function isUniqueViolation(err) {
  return !!err && /UNIQUE constraint failed/i.test(err.message || '');
}
async function resolveConversion(conversionId, status, resolvedAt) {
  await db.runAsync(
    `UPDATE conversion_records SET validation_status = ?, resolved_at = ? WHERE conversion_id = ?`,
    [status, resolvedAt, conversionId]
  );
}
async function earnedTotal() {
  const row = await db.getAsync(
    `SELECT COALESCE(SUM(commission_value), 0) AS total FROM conversion_records WHERE validation_status = 'validated'`
  );
  return row.total;
}

module.exports = {
  createClick, findClick, markClickConverted,
  logPostback, setPostbackResult,
  insertConversion, isUniqueViolation, resolveConversion, earnedTotal,
};
