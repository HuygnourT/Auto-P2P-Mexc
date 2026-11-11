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

const cache = new Map();      // key → { at, res }
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
  if (hit && maxAgeMs > 0 && Date.now() - hit.at <= maxAgeMs) return { ...hit.res, at: hit.at, cached: true };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const res = await a.fetchMarket(side, opts);
    const at = Date.now();
    const m = meta[ex] || (meta[ex] = {});
    if (res.ok) {
      cache.set(key, { at, res });
      m.lastOkAt = at; m.lastError = null;
    } else {
      m.lastError = res.error; m.lastErrorAt = at;
    }
    return { ...res, at, cached: false };
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
 *  onlineOnly (Bybit)
 */
function filterRank(ex, side, items, { minQty = 0, limitMin = 0, amount = 0, onlineOnly = false } = {}) {
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
  const [b, s] = [await get(ex, 'BUY', { maxAgeMs, opts }), await get(ex, 'SELL', { maxAgeMs, opts })];
  const fb = b.ok ? filterRank(ex, 'BUY', b.items, { minQty, limitMin, amount, onlineOnly }) : [];
  const fs = s.ok ? filterRank(ex, 'SELL', s.items, { minQty, limitMin, amount, onlineOnly }) : [];
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
      minQty, limitMin, amount, onlineOnly,
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
  return { ok: true, items: filterRank(ex, side, r.items, { minQty, onlineOnly }), total: r.items.length, at: r.at, cached: r.cached };
}

function status(ex) { return { ...(meta[ex] || {}) }; }
function recordOk(ex) { (meta[ex] || (meta[ex] = {})).lastOkAt = Date.now(); }
function recordError(ex, error) { const m = meta[ex] || (meta[ex] = {}); m.lastError = error; m.lastErrorAt = Date.now(); }

module.exports = { get, best, list, filterRank, status, setMyAdIds, setMyAdsLoader, recordOk, recordError, getMinQty, setMinQty, minQtyAll, getLimitMin, setLimitMin, limitMinAll };
