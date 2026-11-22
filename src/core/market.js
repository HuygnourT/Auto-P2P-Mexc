/**
 * Dữ liệu market dùng chung (engine, bảng giá web, thanh trạng thái, Telegram).
 *  - Cache theo (sàn, chiều, tham số) + gộp request đang chạy → không gọi sàn trùng lặp
 *  - Giá tốt nhất tính theo ĐÚNG quy tắc của engine:
 *      Best BUY  = giá CAO nhất trong ads MUA của merchant khác
 *      Best SELL = giá THẤP nhất trong ads BÁN của merchant khác
 *    bỏ qua ads của chính mình + thương nhân trong whitelist
 */
const adapters = require('./adapters');
const whitelist = require('../services/whitelist');
const settings = require('../services/settings');
const audit = require('./audit');
const bus = require('./bus');
const httpTrace = require('./httpTrace');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// ── Bộ lọc "SL khả dụng tối thiểu" (USDT) cho Giá tốt nhất / Market — RIÊNG từng sàn ──
//    Lưu trong settings.marketFilters, dùng chung cho Telegram + thẻ Market trên web.
//    KHÔNG ảnh hưởng bộ lọc đối thủ của engine tự chỉnh giá.
const FILTER_EXS = ['mexc', 'bitget', 'bybit', 'bingx'];
function minQtyAll() {
  const s = settings.getSettings();
  const mf = s.marketFilters || {};
  const legacy = Number(s.telegram?.marketMinQty) || 0;   // bản trước lưu 1 giá trị chung
  return Object.fromEntries(FILTER_EXS.map(ex => [ex, mf[ex] !== undefined ? (Number(mf[ex]) || 0) : legacy]));
}
function getMinQty(ex) { return minQtyAll()[ex] || 0; }

// ── Bộ lọc "Limit Min" (VND) cho GIÁ TỐT NHẤT — riêng từng sàn (settings.bestPriceFilters) ──
//    Chỉ giữ ads có giới hạn giao dịch tối thiểu (Min) ≥ mức chọn. Chỉ ảnh hưởng cách chọn ads
//    để tính Giá tốt nhất — KHÔNG đổi Min/Max quảng cáo trên sàn, KHÔNG đổi bộ lọc của auto-pricer.
function limitMinAll() {
  const bf = settings.getSettings().bestPriceFilters || {};
  return Object.fromEntries(FILTER_EXS.map(ex => [ex, Number(bf[ex]?.limitMin) || 0]));
}
function getLimitMin(ex) { return limitMinAll()[ex] || 0; }
function setLimitMin(ex, value, meta = {}) {
  if (!FILTER_EXS.includes(ex)) throw new Error('Sàn không hợp lệ');
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) throw new Error('Limit Min phải là số VND ≥ 0');
  const cur = settings.getSettings().bestPriceFilters || {};
  const previous = Number(cur[ex]?.limitMin) || 0;
  if (previous !== v) {
    settings.saveSection('bestPriceFilters', { ...cur, [ex]: { ...(cur[ex] || {}), limitMin: v } });
    audit.record({ exchange: ex, parameter: 'bestPriceLimitMin', previous, next: v, source: meta.source || 'web', status: 'success' });
    bus.emit('bestPriceFilter', { ex, limitMin: v, source: meta.source, client: meta.client });
  }
  return { previous, next: v };
}
function setMinQty(ex, value, meta = {}) {
  if (!FILTER_EXS.includes(ex)) throw new Error('Sàn không hợp lệ');
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) throw new Error('Số lượng tối thiểu phải là số ≥ 0');
  const all = minQtyAll();
  const previous = all[ex];
  if (previous !== v) {
    settings.saveSection('marketFilters', { ...all, [ex]: v });
    audit.record({ exchange: ex, parameter: 'bestPriceMinQty', previous, next: v, source: meta.source || 'web', status: 'success' });
    bus.emit('marketFilter', { ex, minQty: v, source: meta.source, client: meta.client });
  }
  return { previous, next: v };
}

const cache = new Map();      // key → { at, res, snap }
const inflight = new Map();   // key → Promise
const meta = {};              // ex → { lastOkAt, lastError, lastErrorAt }
const myAdIds = {};           // ex → Set(id) — cập nhật bởi engine / ops khi đọc ads của tôi

const keyOf = (ex, side, opts) => `${ex}|${side}|${JSON.stringify(opts || {})}`;

function setMyAdIds(ex, ids) { if (ids === null) { delete myAdIds[ex]; return; } myAdIds[ex] = new Set((ids || []).map(String)); }

// Engine đăng ký hàm tải "ads của tôi" (tránh require vòng). Dùng để luôn loại ads của chính mình
// khỏi giá tốt nhất — kể cả khi engine chưa chạy vòng nào.
let myAdsLoader = null;
function setMyAdsLoader(fn) { myAdsLoader = fn; }
async function ensureMyAds(ex) {
  if (myAdIds[ex] || !myAdsLoader || !adapters.get(ex).isConnected()) return;
  try { await myAdsLoader(ex); } catch (_) {}
}

/**
 * Lấy ads market. maxAgeMs = 0 → luôn lấy mới (nhưng vẫn gộp với request đang chạy).
 */
async function get(ex, side, { maxAgeMs = 15000, opts = {} } = {}) {
  const a = adapters.get(ex);
  const ready = a.marketReady();
  if (!ready.ok) return { ok: false, items: [], error: ready.reason, at: null };

  const key = keyOf(ex, side, opts);
  const hit = cache.get(key);
  if (hit && maxAgeMs > 0 && Date.now() - hit.at <= maxAgeMs) return { ...hit.res, at: hit.at, cached: true, snapId: hit.snap?.id };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    // Ghi lại từng request HTTP thô của lần quét này (debug Raw API JSON)
    const trace = { calls: [] };
    const requestTimestamp = Date.now();
    const res = await httpTrace.run(trace, () => a.fetchMarket(side, opts));
    const at = Date.now();
    const snap = {
      id: `${ex}-${side}-${at}-${++snapSeq}`, ex, side, opts, ok: !!res.ok, partial: !!res.partial, error: res.ok ? null : res.error,
      requestTimestamp, responseTimestamp: at, durationMs: at - requestTimestamp, calls: trace.calls, itemCount: (res.items || []).length,
    };
    rememberSnap(key, snap);
    logScan(snap);
    const m = meta[ex] || (meta[ex] = {});
    if (res.ok) {
      cache.set(key, { at, res, snap });
      m.lastOkAt = at; m.lastError = null;
      // Sự kiện nội bộ (không gửi ra web): theo dõi cạnh tranh đánh giá ngay trên dữ liệu vừa quét
      bus.emit('marketScan', { ex, side, opts, at, items: res.items, snapId: snap.id });
    } else {
      m.lastError = res.error; m.lastErrorAt = at;
      bus.emit('marketScanError', { ex, side, opts, at, error: res.error, snapId: snap.id });
    }
    return { ...res, at, cached: false, snapId: snap.id };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Tham số fetch mặc định cho xem market chung (không dùng bộ lọc riêng của engine) */
function defaultOpts(ex, cfgSection) {
  if (ex === 'bingx') return { pages: cfgSection?.marketPages || 3 };
  if (ex === 'mexc') return { pages: 10 };
  return {};
}

/**
 * Lọc + xếp hạng ads market.
 *  limitMin : Limit Min (VND) của Giá tốt nhất — chỉ giữ ads có Min ≤ số tiền này ≤ Max (nằm trong khoảng giới hạn của ad)
 *  minQty   : số lượng khả dụng tối thiểu (USDT) — bộ lọc của Market, KHÁC "Số lượng GD"
 *  amount   : số tiền giao dịch (VND) phải nằm trong [min, max] của ad (giống bộ lọc engine)
 *  range    : [lo, hi] (VND) — giới hạn giao dịch tham chiếu của Theo dõi cạnh tranh: giữ ads có khoảng
 *             Min–Max GIAO với [lo, hi] (lo = hi = X ⇔ Min ≤ X ≤ Max). Ad không rõ Min/Max → loại
 *  onlineOnly (Bybit)
 *  noNationalLimit (Bybit): bỏ ads có giới hạn quốc gia (tradingPreferenceSet.hasNationalLimit / nationalLimit)
 */
function filterRank(ex, side, items, { minQty = 0, limitMin = 0, amount = 0, onlineOnly = false, noNationalLimit = false, range = null } = {}) {
  const wl = new Set(whitelist.getWhitelist().map(n => n.toLowerCase()));
  const mine = myAdIds[ex] || new Set();
  const out = items.filter(m => {
    if (m.price === null || m.price <= 0) return false;
    if (mine.has(String(m.id))) return false;
    if (m.name && wl.has(String(m.name).toLowerCase())) return false;
    if (minQty > 0 && !(m.available >= minQty)) return false;
    if (limitMin > 0) {   // số tiền phải nằm trong [Min, Max] của ad; ad không rõ Min/Max → loại
      if (m.min === null || m.max === null || limitMin < m.min || limitMin > m.max) return false;
    }
    if (onlineOnly && m.online === false) return false;
    if (noNationalLimit && m.nationalLimited) return false;
    if (range) {
      if (m.min === null || m.max === null || m.max < range[0] || m.min > range[1]) return false;
    }
    if (amount > 0) {
      if (m.min !== null && amount < m.min) return false;
      if (m.max !== null && amount > m.max) return false;
    }
    return true;
  });
  out.sort((x, y) => (side === 'BUY' ? y.price - x.price : x.price - y.price));
  return out;
}

/**
 * Giá tốt nhất 2 chiều của 1 sàn.
 * Trả về { ex, buy, sell, buyAd, sellAd, at, cached, error, stale, filters }
 */
async function best(ex, { minQty = 0, limitMin = 0, amount = 0, maxAgeMs = 15000, cfgSection } = {}) {
  await ensureMyAds(ex);
  const opts = defaultOpts(ex, cfgSection);
  const onlineOnly = ex === 'bybit' ? (cfgSection?.onlineOnly ?? true) : false;
  const noNationalLimit = ex === 'bybit' ? (cfgSection?.noNationalLimit ?? true) : false;
  const [b, s] = [await get(ex, 'BUY', { maxAgeMs, opts }), await get(ex, 'SELL', { maxAgeMs, opts })];
  const fb = b.ok ? filterRank(ex, 'BUY', b.items, { minQty, limitMin, amount, onlineOnly, noNationalLimit }) : [];
  const fs = s.ok ? filterRank(ex, 'SELL', s.items, { minQty, limitMin, amount, onlineOnly, noNationalLimit }) : [];
  const result = {
    ex,
    buy: fb[0]?.price ?? null, sell: fs[0]?.price ?? null,
    buyAd: fb[0] ? { name: fb[0].name, available: fb[0].available } : null,
    sellAd: fs[0] ? { name: fs[0].name, available: fs[0].available } : null,
    // vài ads đủ điều kiện đứng đầu (không kèm dữ liệu gốc) — để hiển thị thông tin quảng cáo tương ứng
    buyTop: fb.slice(0, 3).map(({ raw, ...m }) => m),
    sellTop: fs.slice(0, 3).map(({ raw, ...m }) => m),
    totalBuy: b.ok ? b.items.length : 0, totalSell: s.ok ? s.items.length : 0,
    buyCount: fb.length, sellCount: fs.length,
    at: Math.min(b.at || Date.now(), s.at || Date.now()),
    cached: !!(b.cached && s.cached),
    error: !b.ok ? b.error : (!s.ok ? s.error : null),
    filters: {
      minQty, limitMin, amount, onlineOnly, noNationalLimit,
      whitelistExcluded: whitelist.getWhitelist().length,
      selfExcluded: true,
      depth: ex === 'mexc' ? `${opts.pages} trang` : ex === 'bingx' ? `${opts.pages} trang × 100` : ex === 'bybit' ? '50 ads' : '3 trang × 10',
    },
  };
  bus.emit('market', { ex, best: { buy: result.buy, sell: result.sell, at: result.at, error: result.error } });
  return result;
}

async function list(ex, side, { minQty = 0, maxAgeMs = 15000, cfgSection } = {}) {
  await ensureMyAds(ex);
  const opts = defaultOpts(ex, cfgSection);
  const r = await get(ex, side, { maxAgeMs, opts });
  if (!r.ok) return { ok: false, items: [], error: r.error, at: r.at };
  const onlineOnly = ex === 'bybit' ? (cfgSection?.onlineOnly ?? true) : false;
  const noNationalLimit = ex === 'bybit' ? (cfgSection?.noNationalLimit ?? true) : false;
  return { ok: true, items: filterRank(ex, side, r.items, { minQty, onlineOnly, noNationalLimit }), total: r.items.length, at: r.at, cached: r.cached };
}

// ══════════════════════════════════════════════════════════
// DEBUG — Raw API JSON của ads đối thủ
// ══════════════════════════════════════════════════════════
let snapSeq = 0;
const snaps = new Map();          // snapId → snapshot (giữ vài lần quét gần nhất mỗi key, kể cả lần lỗi)
const snapsByKey = new Map();     // key → [snapId...] (mới nhất cuối)
const SNAPS_PER_KEY = 3;
const debugLog = [];              // các request market gần nhất (không có body)
const DEBUG_MAX = 500;
const DEBUG_PATH = path.join(__dirname, '..', '..', 'data', 'market-api-debug.log');
const DEBUG_MAX_BYTES = 5 * 1024 * 1024;
const LABELS = { mexc: 'MEXC', bitget: 'Bitget', bybit: 'Bybit', bingx: 'BingX' };

function rememberSnap(key, snap) {
  snaps.set(snap.id, snap);
  const list = snapsByKey.get(key) || [];
  list.push(snap.id);
  while (list.length > SNAPS_PER_KEY) snaps.delete(list.shift());
  snapsByKey.set(key, list);
}

function logScan(snap) {
  const rows = snap.calls.length ? snap.calls.map((c, i) => ({
    at: c.endedAt, exchange: snap.ex, side: snap.side, endpoint: c.endpoint, method: c.method, params: c.params,
    httpStatus: c.httpStatus, durationMs: c.durationMs, ok: !c.error && snap.ok, error: c.error || (i === snap.calls.length - 1 && !snap.ok ? snap.error : null),
    snapId: snap.id, callIndex: i,
  })) : [{
    at: snap.responseTimestamp, exchange: snap.ex, side: snap.side, endpoint: null, method: null, params: null,
    httpStatus: null, durationMs: snap.durationMs, ok: snap.ok, error: snap.error || 'Không có request HTTP (chưa kết nối?)', snapId: snap.id, callIndex: null,
  }];
  for (const row of rows) {
    debugLog.push(row);
    if (debugLog.length > DEBUG_MAX) debugLog.shift();
  }
  try {
    try { if (fs.statSync(DEBUG_PATH).size > DEBUG_MAX_BYTES) fs.renameSync(DEBUG_PATH, DEBUG_PATH + '.1'); } catch (_) {}
    fs.appendFileSync(DEBUG_PATH, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch (err) { logger.debug(`[Market] Không ghi được debug log: ${err.message}`); }
}

function debugEntries({ ex, limit = 100 } = {}) {
  const list = ex ? debugLog.filter(r => r.exchange === ex) : debugLog;
  return list.slice(-Math.min(500, limit)).reverse();
}

/** Tìm đường dẫn của object gốc trong body (so khớp theo tham chiếu — không dựng lại dữ liệu) */
function locate(body, target, p = '', depth = 0) {
  if (!body || typeof body !== 'object' || depth > 5) return null;
  if (Array.isArray(body)) {
    const i = body.indexOf(target);
    if (i >= 0) return `${p}[${i}]`;
    for (let j = 0; j < body.length; j++) { const f = locate(body[j], target, `${p}[${j}]`, depth + 1); if (f) return f; }
    return null;
  }
  for (const [k, v] of Object.entries(body)) {
    if (v && typeof v === 'object') { const f = locate(v, target, p ? `${p}.${k}` : k, depth + 1); if (f) return f; }
  }
  return null;
}

const iso = ts => (ts ? new Date(ts).toISOString() : null);

function wrap(ex, side, adId, entry, { source }) {
  const item = entry.res.items.find(m => String(m.id) === String(adId));
  if (!item) return null;
  const snap = entry.snap;
  let callIndex = null, jsonPath = null;
  if (snap) {
    for (let i = 0; i < snap.calls.length; i++) {
      const f = locate(snap.calls[i].body, item.raw);
      if (f) { callIndex = i; jsonPath = f; break; }
    }
  }
  const call = callIndex !== null ? snap.calls[callIndex] : null;
  const { raw, ...parsed } = item;
  return {
    exchange: LABELS[ex], exchangeKey: ex, side, advertisementId: String(adId),
    source,                                            // 'fresh' = vừa lấy từ sàn · 'cached' = bản đã lưu của lần quét trước
    ageSeconds: Math.round((Date.now() - entry.at) / 1000),
    snapshotId: snap?.id || null,
    endpoint: call ? `${call.method} ${call.endpoint}` : null,
    requestParams: call ? call.params : null,
    requestTimestamp: iso(call?.startedAt ?? snap?.requestTimestamp),
    responseTimestamp: iso(call?.endedAt ?? snap?.responseTimestamp),
    httpStatus: call ? call.httpStatus : null,
    durationMs: call ? call.durationMs : null,
    scan: snap ? { requestTimestamp: iso(snap.requestTimestamp), responseTimestamp: iso(snap.responseTimestamp), durationMs: snap.durationMs, requests: snap.calls.length, itemCount: snap.itemCount, partial: snap.partial } : null,
    location: call ? { callIndex, jsonPath, note: `Phần tử ${jsonPath} trong response của request #${callIndex + 1}/${snap.calls.length}` } : null,
    rawResponseAvailable: !!call,
    rawAdvertisement: raw,                             // object GỐC của sàn — không đổi tên/không sửa trường
    ...(ex === 'bingx' ? { parseNote: 'BingX: số nguyên ≥ 16 chữ số (vd advertNo) được đọc thành chuỗi để không sai số trong JavaScript — xem "Body HTTP thô" để thấy đúng định dạng số gốc của sàn' } : {}),
    parsedAdvertisement: parsed,                       // dữ liệu tool đọc ra (để đối chiếu)
  };
}

function entriesFor(ex, side) {
  const out = [];
  for (const [k, v] of cache) if (k.startsWith(`${ex}|${side}|`)) out.push(v);
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Raw JSON của 1 ad đối thủ.
 *  refresh = true → gọi sàn lấy mới. Nếu lấy mới lỗi → trả lỗi (KHÔNG âm thầm thay bằng cache);
 *  bản cache (nếu có) được trả kèm riêng, ghi rõ là cache.
 */
async function rawAd(ex, side, adId, { refresh = false, cfgSection } = {}) {
  const RAW_EXS = ['mexc', 'bybit', 'bingx'];
  if (!RAW_EXS.includes(ex)) return { ok: false, error: `${LABELS[ex] || ex}: chưa hỗ trợ xem Raw API JSON` };
  if (!['BUY', 'SELL'].includes(side)) return { ok: false, error: 'side không hợp lệ' };
  let refreshFail = null;
  if (!refresh && !entriesFor(ex, side).length) refresh = true;   // chưa có lượt quét nào → lấy từ sàn (ghi rõ là "fresh")
  if (refresh) {
    const r = await get(ex, side, { maxAgeMs: 0, opts: defaultOpts(ex, cfgSection) });
    if (!r.ok) {
      const snap = snaps.get(r.snapId);
      const last = snap?.calls[snap.calls.length - 1];
      refreshFail = { error: r.error, at: iso(r.at), endpoint: last ? `${last.method} ${last.endpoint}` : null, httpStatus: last?.httpStatus ?? null, snapshotId: r.snapId || null };
    }
  }
  const entries = entriesFor(ex, side);
  let found = null;
  for (const e of entries) { found = wrap(ex, side, adId, e, { source: refresh && !refreshFail && e === entries[0] ? 'fresh' : 'cached' }); if (found) break; }
  if (refreshFail) return { ok: false, error: `Làm mới từ sàn thất bại: ${refreshFail.error}`, refreshError: refreshFail, cached: found };
  if (!found) {
    return { ok: false, error: entries.length ? 'Quảng cáo không còn trong response gần nhất của sàn (có thể đã bị gỡ hoặc đổi thứ hạng)' : 'Chưa có dữ liệu market cho sàn/chiều này — hãy tải market trước' };
  }
  return { ok: true, data: found };
}

/** Body đầy đủ của 1 request trong 1 lần quét (để xem/tải toàn bộ response) */
function rawResponse(snapId, callIndex) {
  const snap = snaps.get(String(snapId));
  if (!snap) return { ok: false, error: 'Lần quét này không còn trong bộ nhớ (chỉ giữ vài lần quét gần nhất) — hãy làm mới' };
  const c = snap.calls[Number(callIndex)];
  if (!c) return { ok: false, error: 'Không có request này' };
  return {
    ok: true,
    data: {
      exchange: LABELS[snap.ex], side: snap.side, snapshotId: snap.id, callIndex: Number(callIndex), requests: snap.calls.length,
      endpoint: `${c.method} ${c.endpoint}`, requestParams: c.params,
      requestTimestamp: iso(c.startedAt), responseTimestamp: iso(c.endedAt), httpStatus: c.httpStatus, durationMs: c.durationMs, error: c.error,
      response: c.body,
    },
    rawText: c.rawText,
  };
}

/** Lượt quét thành công gần nhất (bất kể ai quét: engine, Giá tốt nhất, Market...) — KHÔNG gọi API */
function latest(ex, side) {
  const e = entriesFor(ex, side)[0];
  return e ? { items: e.res.items, at: e.at, snapId: e.snap?.id || null } : null;
}

function status(ex) { return { ...(meta[ex] || {}) }; }
function recordOk(ex) { (meta[ex] || (meta[ex] = {})).lastOkAt = Date.now(); }
function recordError(ex, error) { const m = meta[ex] || (meta[ex] = {}); m.lastError = error; m.lastErrorAt = Date.now(); }

module.exports = { get, best, list, filterRank, status, defaultOpts, latest, rawAd, rawResponse, debugEntries, setMyAdIds, setMyAdsLoader, recordOk, recordError, getMinQty, setMinQty, minQtyAll, getLimitMin, setLimitMin, limitMinAll };
