/**
 * Kho cấu hình auto-pricing dùng chung (web + Telegram + engine).
 *
 * Lưu trong data/settings.json, GIỮ NGUYÊN định dạng cũ để cấu hình đã lưu dùng tiếp được:
 *   mexcPricer   { scanInterval, apConfigs: { [advNo]: cfg } }
 *   bitgetPricer { scanInterval, offsetBuy, offsetSell, filterAmount, rows: [row] }
 *   bybitPricer  { scanInterval, onlineOnly, rows: [row] }
 *   bingxPricer  { scanInterval, marketPages, configs: { [advertNo]: cfg } }
 *
 * Thêm mới (không phá cấu hình cũ):
 *   _v            — số phiên bản mỗi cấu hình ad/dòng (chống ghi đè khi web & Telegram cùng sửa)
 *   priceFloor    — sàn giá cho ad MUA   (trần của ad MUA vẫn là priceLimit như cũ)
 *   priceCeiling  — trần giá cho ad BÁN  (sàn của ad BÁN vẫn là priceLimit như cũ)
 *
 * Mỗi thay đổi được ghi file ngay và phát sự kiện 'config' để web/Telegram đồng bộ.
 */
const settings = require('../services/settings');
const bus = require('./bus');

const SECTION = { mexc: 'mexcPricer', bitget: 'bitgetPricer', bybit: 'bybitPricer', bingx: 'bingxPricer' };
const MAP_KEY = { mexc: 'apConfigs', bingx: 'configs' };   // sàn cấu hình theo ad
const ROW_EX = new Set(['bitget', 'bybit']);               // sàn cấu hình theo dòng (row)
const RUNTIME_FIELDS = ['lastStatus'];

const SECTION_DEFAULTS = {
  mexc: { scanInterval: 30, apConfigs: {} },
  bitget: { scanInterval: 1, offsetBuy: -50, offsetSell: 50, filterAmount: '', rows: [] },
  bybit: { scanInterval: 30, onlineOnly: true, rows: [] },
  bingx: { scanInterval: 30, marketPages: 3, configs: {} },
};

let cache = null;
function load() {
  if (cache) return cache;
  const all = settings.getSettings();
  cache = {};
  for (const ex of Object.keys(SECTION)) {
    const saved = all[SECTION[ex]] || {};
    const sec = { ...SECTION_DEFAULTS[ex], ...saved };
    if (MAP_KEY[ex]) sec[MAP_KEY[ex]] = { ...(saved[MAP_KEY[ex]] || {}) };
    if (ROW_EX.has(ex)) sec.rows = Array.isArray(saved.rows) ? saved.rows.map(r => ({ ...r })) : [];
    // số hoá các giá trị toàn cục cũ (trước đây lưu dạng chuỗi từ input)
    sec.scanInterval = Number(sec.scanInterval) || SECTION_DEFAULTS[ex].scanInterval;
    if (ex === 'bingx') sec.marketPages = Number(sec.marketPages) || 3;
    if (ex === 'bybit' && sec.onlineOnly === undefined) sec.onlineOnly = true;
    cache[ex] = sec;
  }
  return cache;
}

function persist(ex) {
  const sec = load()[ex];
  const out = JSON.parse(JSON.stringify(sec));
  const strip = o => { for (const f of RUNTIME_FIELDS) delete o[f]; };
  if (MAP_KEY[ex]) Object.values(out[MAP_KEY[ex]]).forEach(strip);
  if (ROW_EX.has(ex)) out.rows.forEach(strip);
  settings.saveSection(SECTION[ex], out);
}

function section(ex) {
  if (!SECTION[ex]) throw new Error(`Sàn không hợp lệ: ${ex}`);
  return load()[ex];
}

// ── Cấu hình toàn cục của 1 sàn (chu kỳ quét, offset chung...) ──
const GLOBAL_FIELDS = {
  mexc: ['scanInterval'],
  bitget: ['scanInterval', 'offsetBuy', 'offsetSell', 'filterAmount'],
  bybit: ['scanInterval', 'onlineOnly'],
  bingx: ['scanInterval', 'marketPages'],
};
function patchSettings(ex, patch, meta = {}) {
  const sec = section(ex);
  const changed = {};
  for (const f of GLOBAL_FIELDS[ex]) {
    if (patch[f] === undefined) continue;
    let v = patch[f];
    if (f === 'scanInterval' || f === 'marketPages') v = Math.max(1, Number(v) || SECTION_DEFAULTS[ex][f]);
    else if (f === 'onlineOnly') v = !!v;
    if (sec[f] !== v) { changed[f] = { previous: sec[f], next: v }; sec[f] = v; }
  }
  if (Object.keys(changed).length) {
    persist(ex);
    bus.emit('config', { ex, scope: 'settings', settings: globalOf(ex), source: meta.source, client: meta.client });
  }
  return changed;
}
function globalOf(ex) {
  const sec = section(ex);
  const o = {};
  for (const f of GLOBAL_FIELDS[ex]) o[f] = sec[f];
  return o;
}

// ── Cấu hình mặc định khi bật auto-pricing cho 1 ad lần đầu (giống giao diện cũ) ──
function defaultAdCfg(ex, ad = {}) {
  const isBuy = ad.side === 'BUY';
  if (ex === 'mexc') {
    return {
      enabled: false, amount: '', onlineMinutes: 30, offset: isBuy ? -50 : 50, priceLimit: '',
      refillThreshold: '', refillQuantity: '', minTrans: ad.min ?? '', maxTrans: ad.max ?? '',
      userAllTradeCountMin: 0, userAllTradeCountMax: 0, filterMaxSingleTransAmount: 0, payMethod: 1799581,
      priceFloor: '', priceCeiling: '', _v: 1,
    };
  }
  if (ex === 'bingx') {
    return { enabled: false, searchAmount: '', offset: 0, priceLimit: '', minTrades30d: '', minAmount: '', maxAmount: '',
      priceFloor: '', priceCeiling: '', _v: 1 };
  }
  if (ex === 'bitget') {
    return { side: isBuy ? 'buy' : 'sell', advId: String(ad.id || ''), priceLimit: '', minAmount: '', maxAmount: '', quantity: '',
      searchAmount: '', offset: '', refillThreshold: '', refillQuantity: '', enabled: false,
      priceFloor: '', priceCeiling: '', _v: 1 };
  }
  if (ex === 'bybit') {
    return { side: isBuy ? 'buy' : 'sell', advId: String(ad.id || ''), tokenId: ad.asset || 'USDT', currencyId: ad.fiat || 'VND',
      searchAmount: '', offset: '', priceLimit: '', refill: '', qtyMode: 'refill', minAmount: '', maxAmount: '', enabled: false,
      priceFloor: '', priceCeiling: '', _v: 1 };
  }
  return {};
}

// ── Truy cập cấu hình theo ad ──
function nextRowId(ex) {
  return Math.max(0, ...section(ex).rows.map(r => Number(r.id) || 0)) + 1;
}

/** Trả về { key, cfg } — key là advNo (mexc/bingx) hoặc row.id (bitget/bybit) */
function findAdCfg(ex, adId) {
  const sec = section(ex);
  if (MAP_KEY[ex]) {
    const cfg = sec[MAP_KEY[ex]][String(adId)];
    return cfg ? { key: String(adId), cfg } : null;
  }
  const row = sec.rows.find(r => String(r.advId) === String(adId));
  return row ? { key: row.id, cfg: row } : null;
}

function getByKey(ex, key) {
  const sec = section(ex);
  if (MAP_KEY[ex]) return sec[MAP_KEY[ex]][String(key)] || null;
  return sec.rows.find(r => String(r.id) === String(key)) || null;
}

/** Tạo cấu hình mặc định cho ad nếu chưa có (không bật auto-pricing) */
function ensureAdCfg(ex, ad, meta = {}) {
  const found = findAdCfg(ex, ad.id);
  if (found) return found;
  const cfg = defaultAdCfg(ex, ad);
  const sec = section(ex);
  let key;
  if (MAP_KEY[ex]) { key = String(ad.id); sec[MAP_KEY[ex]][key] = cfg; }
  else { key = nextRowId(ex); cfg.id = key; sec.rows.push(cfg); }
  persist(ex);
  bus.emit('config', { ex, scope: 'ad', key, cfg, source: meta.source || 'system', client: meta.client });
  return { key, cfg };
}

class VersionConflictError extends Error {
  constructor(current) { super('Cấu hình vừa được thay đổi ở nơi khác — tải lại rồi thử lại'); this.code = 'VERSION_CONFLICT'; this.current = current; }
}

/**
 * Sửa cấu hình 1 ad/dòng theo key. expectV: phiên bản mà người sửa đang thấy (tuỳ chọn).
 * Trả về { cfg, changed: {field: {previous, next}} }
 */
function patchByKey(ex, key, patch, meta = {}) {
  const cfg = getByKey(ex, key);
  if (!cfg) throw new Error('Không tìm thấy cấu hình');
  const curV = cfg._v || 1;
  if (meta.expectV != null && Number(meta.expectV) !== curV) throw new VersionConflictError(cfg);
  const changed = {};
  for (const [f, v] of Object.entries(patch)) {
    if (f === 'id' || f === '_v' || RUNTIME_FIELDS.includes(f)) continue;
    if (cfg[f] !== v) { changed[f] = { previous: cfg[f] === undefined ? '' : cfg[f], next: v }; cfg[f] = v; }
  }
  if (Object.keys(changed).length) {
    cfg._v = curV + 1;
    persist(ex);
    bus.emit('config', { ex, scope: 'ad', key, cfg, source: meta.source, client: meta.client });
  }
  return { cfg, changed };
}

function addRow(ex, row = {}, meta = {}) {
  if (!ROW_EX.has(ex)) throw new Error('Sàn này cấu hình theo ad, không theo dòng');
  const cfg = { ...defaultAdCfg(ex, { side: row.side === 'sell' ? 'SELL' : 'BUY' }), ...row, id: nextRowId(ex), _v: 1 };
  section(ex).rows.push(cfg);
  persist(ex);
  bus.emit('config', { ex, scope: 'ad', key: cfg.id, cfg, source: meta.source, client: meta.client });
  return cfg;
}

function removeRow(ex, key, meta = {}) {
  if (!ROW_EX.has(ex)) throw new Error('Sàn này cấu hình theo ad, không theo dòng');
  const sec = section(ex);
  const before = sec.rows.length;
  sec.rows = sec.rows.filter(r => String(r.id) !== String(key));
  if (sec.rows.length !== before) {
    persist(ex);
    bus.emit('config', { ex, scope: 'removed', key, source: meta.source, client: meta.client });
    return true;
  }
  return false;
}

// ── Ánh xạ tham số chung (Telegram) → field thật trong cấu hình từng sàn ──
//    tradingQty = "Số lượng GD / SL tìm giá" (VND) — KHÁC số lượng của quảng cáo
function fieldFor(ex, param, isBuy) {
  switch (param) {
    case 'tradingQty': return ex === 'mexc' ? 'amount' : 'searchAmount';
    case 'min': return ex === 'mexc' ? 'minTrans' : 'minAmount';
    case 'max': return ex === 'mexc' ? 'maxTrans' : 'maxAmount';
    case 'ceiling': return isBuy ? 'priceLimit' : 'priceCeiling';
    case 'floor': return isBuy ? 'priceFloor' : 'priceLimit';
    case 'enabled': return 'enabled';
    default: return null;
  }
}

/** Sàn / trần hiệu lực của 1 cấu hình */
function boundsOf(cfg, isBuy) {
  const n = v => (v === '' || v == null || isNaN(parseFloat(v))) ? null : parseFloat(v);
  return isBuy
    ? { floor: n(cfg.priceFloor), ceiling: n(cfg.priceLimit) }
    : { floor: n(cfg.priceLimit), ceiling: n(cfg.priceCeiling) };
}

function snapshot() {
  return JSON.parse(JSON.stringify(load()));
}

module.exports = {
  SECTION, ROW_EX, section, snapshot, patchSettings, globalOf,
  findAdCfg, getByKey, ensureAdCfg, patchByKey, addRow, removeRow,
  fieldFor, boundsOf, defaultAdCfg, VersionConflictError,
};
