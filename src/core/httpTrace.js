/**
 * Ghi nhận request HTTP thô của các lần quét market (debug "Raw API JSON" của ads đối thủ).
 *
 *  - market.get() chạy fetchMarket() bên trong run(trace, ...) — AsyncLocalStorage giữ ngữ cảnh
 *    qua mọi await, nên service của từng sàn chỉ cần gọi record(...) sau mỗi request.
 *  - Ngoài ngữ cảnh đó (ads của tôi, sửa giá, ...) record() không làm gì → không ghi dữ liệu tài khoản.
 *  - Tham số request được CHE các trường nhạy cảm (signature, apiKey, token, ...). Header không bao giờ được ghi.
 *  - Body response được giữ NGUYÊN VẸN (dữ liệu market công khai) để đối chiếu đúng trường gốc của sàn.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
// Chỉ che đúng trường nhạy cảm (vd "tokenId": "USDT" của Bybit là mã coin — KHÔNG che)
const SENSITIVE = /^(sign|signature|sig)$|signature|secret|api.?key|apikey|^token$|access.?token|auth|cookie|session|passphrase|password|credential/i;
const MAX_RAW_TEXT = 4 * 1024 * 1024;

/** Bản sao đã che trường nhạy cảm (dùng cho tham số request / log) */
function redact(v, depth = 0) {
  if (v === null || v === undefined || depth > 6) return v ?? null;
  if (Array.isArray(v)) return v.map(x => redact(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SENSITIVE.test(k) ? '[ẩn]' : redact(val, depth + 1);
    return o;
  }
  return v;
}

function run(trace, fn) { return als.run(trace, fn); }
function active() { return als.getStore() || null; }

/**
 * entry: { exchange, method, endpoint, params, httpStatus, startedAt, endedAt, body, rawText, error }
 */
function record(entry) {
  const t = active();
  if (!t) return;
  const startedAt = entry.startedAt || Date.now();
  const endedAt = entry.endedAt || Date.now();
  t.calls.push({
    exchange: entry.exchange,
    method: entry.method || 'GET',
    endpoint: entry.endpoint,
    params: redact(entry.params || {}),
    httpStatus: entry.httpStatus ?? null,
    startedAt, endedAt, durationMs: endedAt - startedAt,
    body: entry.body === undefined ? null : entry.body,
    rawText: typeof entry.rawText === 'string' ? entry.rawText.slice(0, MAX_RAW_TEXT) : null,
    error: entry.error || null,
  });
}

module.exports = { run, active, record, redact, SENSITIVE };
