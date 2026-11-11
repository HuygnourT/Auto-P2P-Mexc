/**
 * Nhật ký thay đổi cấu hình & kết quả cập nhật lên sàn (data/audit.log, mỗi dòng 1 JSON).
 * KHÔNG ghi API key / secret / bot token — chỉ ghi giá trị tham số cấu hình.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const bus = require('./bus');

const AUDIT_PATH = path.join(__dirname, '..', '..', 'data', 'audit.log');
const MAX_BYTES = 5 * 1024 * 1024;   // xoay vòng khi > 5MB
const recentBuf = [];

const SENSITIVE = /key|secret|token|passphrase|password/i;
function clean(v) {
  if (v === undefined) return null;
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SENSITIVE.test(k) ? '[ẩn]' : val;
    return o;
  }
  return v;
}

/**
 * @param {object} e
 *  exchange, adId, parameter, previous, next, source ('telegram'|'web'|'engine'),
 *  status ('success'|'failed'|'rejected'), exchangeStatus (vd "code=0" / "HTTP 500"), message
 */
function record(e) {
  const entry = {
    ts: new Date().toISOString(),
    exchange: e.exchange || null,
    adId: e.adId != null ? String(e.adId) : null,
    parameter: e.parameter || null,
    previous: clean(e.previous),
    next: clean(e.next),
    source: e.source || 'web',
    status: e.status || 'success',
    exchangeStatus: e.exchangeStatus ?? null,
    message: e.message ? String(e.message).slice(0, 300) : null,
  };
  try {
    const dir = path.dirname(AUDIT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(AUDIT_PATH) && fs.statSync(AUDIT_PATH).size > MAX_BYTES) {
      fs.renameSync(AUDIT_PATH, AUDIT_PATH + '.1');
    }
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.error('[Audit] write error:', err.message);
  }
  recentBuf.unshift(entry);
  if (recentBuf.length > 200) recentBuf.pop();
  bus.emit('audit', entry);
  return entry;
}

function recent(limit = 50) {
  if (!recentBuf.length) {
    try {
      const lines = fs.existsSync(AUDIT_PATH) ? fs.readFileSync(AUDIT_PATH, 'utf-8').trim().split('\n') : [];
      for (const l of lines.slice(-200).reverse()) { try { recentBuf.push(JSON.parse(l)); } catch (_) {} }
    } catch (_) {}
  }
  return recentBuf.slice(0, limit);
}

module.exports = { record, recent };
