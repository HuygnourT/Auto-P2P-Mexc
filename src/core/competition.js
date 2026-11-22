/**
 * TOP-OF-MARKET COMPETITION — phát hiện khi trần/sàn giá của tôi mất khả năng cạnh tranh.
 *
 *  - Tách biệt hoàn toàn với Auto Pricing: chỉ ĐỌC dữ liệu market + cấu hình, KHÔNG tự đổi giá/trần/sàn.
 *  - KHÔNG tự gọi API sàn (tránh giới hạn API): chỉ đánh giá mỗi khi có lượt quét market thành công
 *    (sự kiện 'marketScan' — chủ yếu từ Auto Pricing mỗi lần kiểm tra giá; cũng nhận lượt quét của
 *    Giá tốt nhất / Market). Auto Pricing dừng → không có dữ liệu mới → không cảnh báo.
 *  - "Đánh giá lại" / đổi cấu hình: dùng lượt quét gần nhất trong cache nếu còn mới, không gọi sàn.
 *  - Chỉ đánh giá trên dữ liệu VỪA quét thành công; quét lỗi → không so sánh, không cảnh báo.
 *
 *  Quy tắc (giống engine):  Best BUY = giá CAO nhất trong ads MUA đủ điều kiện của merchant khác
 *                           Best SELL = giá THẤP nhất trong ads BÁN đủ điều kiện của merchant khác
 *  Cảnh báo BUY  khi  Trần MUA của tôi  < Best BUY đối thủ
 *  Cảnh báo SELL khi  Sàn BÁN của tôi   > Best SELL đối thủ
 *  (trần/sàn là của từng quảng cáo đang bật Auto Repricing — cùng trường cấu hình engine dùng)
 *
 *  Giới hạn giao dịch tham chiếu (VND) chỉ dùng để LỌC đối thủ, không bao giờ so với giá (VND/USDT).
 */
const settings = require('../services/settings');
const logger = require('../utils/logger');
const bus = require('./bus');
const store = require('./store');
const engine = require('./engine');
const market = require('./market');
const adapters = require('./adapters');
const audit = require('./audit');
const fs = require('fs');
const path = require('path');

const EXS = ['bybit', 'bingx', 'mexc'];
const SIDES = ['BUY', 'SELL'];
const LABEL = { mexc: 'MEXC', bybit: 'Bybit', bingx: 'BingX' };
const DEFAULTS = { cooldownMin: 5, minChangeVnd: 10 };
const SIDE_DEFAULT = { enabled: false, refPrice: null, refLimitMin: null, refLimitMax: null };
// Lượt quét cũ hơn ngưỡng này thì không dùng để đánh giá lại (tránh cảnh báo từ dữ liệu cũ)
const reevalMaxAge = ex => Math.max(90000, ((Number(store.globalOf(ex)?.scanInterval) || 30) * 2 + 30) * 1000);
const LOG_PATH = path.join(__dirname, '..', '..', 'data', 'competition.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const runtime = {};               // `${ex}:${side}` → trạng thái lần đánh giá gần nhất
const alertState = new Map();     // `${ex}:${side}:${adId}` → { active, lastAlertAt, lastAlertPrice, lastBoundary, pending, ignoredPrice }
const alerts = new Map();         // alertId → payload (để nút Telegram/web tham chiếu)
const history = [];               // nhật ký đánh giá gần nhất
const HISTORY_MAX = 500;
let alertSeq = 0;
const evaluating = new Map();     // key → { running, again }

// ══════════════════════════════════════════════════════════
// CẤU HÌNH (settings.competition) — dùng chung web ↔ Telegram
// ══════════════════════════════════════════════════════════
function config() {
  const c = settings.getSettings().competition || {};
  const out = {
    cooldownMin: Number.isFinite(Number(c.cooldownMin)) && Number(c.cooldownMin) >= 0 ? Number(c.cooldownMin) : DEFAULTS.cooldownMin,
    minChangeVnd: Number.isFinite(Number(c.minChangeVnd)) && Number(c.minChangeVnd) >= 0 ? Number(c.minChangeVnd) : DEFAULTS.minChangeVnd,
  };
  for (const ex of EXS) {
    out[ex] = {};
    for (const side of SIDES) out[ex][side] = { ...SIDE_DEFAULT, ...((c[ex] || {})[side] || {}) };
  }
  return out;
}
function sideCfg(ex, side) { return config()[ex][side]; }

const numOrNull = v => (v === '' || v === null || v === undefined ? null : Number(v));

/** Trần/sàn của các ad đang theo dõi (để kiểm tra giá tham chiếu) */
function boundaryRange(ex, side) {
  const isBuy = side === 'BUY';
  const floors = [], ceilings = [];
  for (const ad of engine.getMyAds(ex).filter(a => a.side === side)) {
    const found = store.findAdCfg(ex, ad.id);
    if (!found?.cfg?.enabled) continue;
    const b = store.boundsOf(found.cfg, isBuy);
    if (b.floor !== null) floors.push(b.floor);
    if (b.ceiling !== null) ceilings.push(b.ceiling);
  }
  return { floor: floors.length ? Math.min(...floors) : null, ceiling: ceilings.length ? Math.max(...ceilings) : null };
}

/** Kiểm tra + lưu cấu hình 1 sàn/1 chiều. patch: { enabled, refPrice, refLimitMin, refLimitMax } */
function setSideConfig(ex, side, patch, meta = {}) {
  if (!EXS.includes(ex)) throw new Error('Sàn không hỗ trợ theo dõi cạnh tranh');
  if (!SIDES.includes(side)) throw new Error('Chiều phải là BUY hoặc SELL');
  const cur = sideCfg(ex, side);
  const next = { ...cur };
  if ('enabled' in patch) next.enabled = !!patch.enabled;
  for (const f of ['refPrice', 'refLimitMin', 'refLimitMax']) {
    if (!(f in patch)) continue;
    const v = numOrNull(patch[f]);
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw new Error(`${FIELD_LABEL[f]} phải là số ≥ 0`);
    next[f] = v === 0 && f !== 'refPrice' ? null : v;
  }
  if (next.refPrice !== null && next.refPrice <= 0) throw new Error('Giá tham chiếu phải lớn hơn 0');
  if (next.refLimitMin !== null && next.refLimitMax !== null && next.refLimitMin > next.refLimitMax) {
    throw new Error(`Limit Min tham chiếu (${fmtN(next.refLimitMin)}) phải ≤ Limit Max tham chiếu (${fmtN(next.refLimitMax)})`);
  }
  if ('refPrice' in patch && next.refPrice !== null) {
    const b = boundaryRange(ex, side);
    if (b.floor !== null && next.refPrice < b.floor) throw new Error(`Giá tham chiếu (${fmtN(next.refPrice)}) thấp hơn sàn giá ${side === 'BUY' ? 'MUA' : 'BÁN'} đang cấu hình (${fmtN(b.floor)})`);
    if (b.ceiling !== null && next.refPrice > b.ceiling) throw new Error(`Giá tham chiếu (${fmtN(next.refPrice)}) cao hơn trần giá ${side === 'BUY' ? 'MUA' : 'BÁN'} đang cấu hình (${fmtN(b.ceiling)})`);
  }

  const all = settings.getSettings().competition || {};
  const exCfg = { ...(all[ex] || {}), [side]: next };
  settings.saveSection('competition', { ...all, [ex]: exCfg });
  for (const f of Object.keys(next)) {
    if (cur[f] === next[f]) continue;
    audit.record({ exchange: ex, parameter: `competition.${side}.${f}`, previous: cur[f], next: next[f], source: meta.source || 'web', status: 'success' });
  }
  if ('enabled' in patch && cur.enabled !== next.enabled) {
    if (!next.enabled) clearSide(ex, side);
    logEvent({ type: next.enabled ? 'monitorOn' : 'monitorOff', ex, side, source: meta.source || 'web' });
  }
  emitState(ex, side, meta);
  if (next.enabled) setTimeout(() => reevalLatest(ex, side).catch(() => {}), 0);
  return next;
}
const FIELD_LABEL = { refPrice: 'Giá tham chiếu', refLimitMin: 'Limit Min tham chiếu', refLimitMax: 'Limit Max tham chiếu' };

function setGlobal(patch, meta = {}) {
  const all = settings.getSettings().competition || {};
  const cur = config();
  const next = { ...all };
  for (const f of ['cooldownMin', 'minChangeVnd']) {
    if (!(f in patch)) continue;
    const v = Number(patch[f]);
    if (!Number.isFinite(v) || v < 0) throw new Error(f === 'cooldownMin' ? 'Thời gian chờ phải là số phút ≥ 0' : 'Ngưỡng thay đổi giá phải là số VND ≥ 0');
    next[f] = v;
    if (cur[f] !== v) audit.record({ exchange: '-', parameter: `competition.${f}`, previous: cur[f], next: v, source: meta.source || 'web', status: 'success' });
  }
  settings.saveSection('competition', next);
  bus.emit('competition', { type: 'config', source: meta.source, client: meta.client });
  return config();
}

// ══════════════════════════════════════════════════════════
// ĐÁNH GIÁ
// ══════════════════════════════════════════════════════════
const fmtN = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const rangeOf = c => {
  const lo = c.refLimitMin, hi = c.refLimitMax;
  if (lo === null && hi === null) return null;
  return [lo ?? hi, hi ?? lo];
};

function competitorSummary(m) {
  if (!m) return null;
  return { id: m.id, name: m.name, price: m.price, min: m.min, max: m.max, available: m.available, completion: m.completion ?? null, payments: (m.payments || []).slice(0, 4), online: m.online };
}

async function evaluate(ex, side, items, { at = Date.now(), snapId = null, trigger = 'scan' } = {}) {
  const c = sideCfg(ex, side);
  const key = `${ex}:${side}`;
  if (!c.enabled) return null;
  if (!engine.getMyAds(ex).length && adapters.get(ex).isConnected()) await engine.refreshMyAds(ex, { maxAgeMs: 60000 }).catch(() => {});

  const isBuy = side === 'BUY';
  const range = rangeOf(c);
  const onlineOnly = ex === 'bybit' ? (store.section('bybit').onlineOnly ?? true) : false;
  const noNationalLimit = ex === 'bybit' ? (store.section('bybit').noNationalLimit ?? true) : false;
  const eligible = market.filterRank(ex, side, items, { onlineOnly, noNationalLimit, range });
  const best = eligible[0] || null;
  const g = config();
  const now = Date.now();

  const rows = [];
  for (const ad of engine.getMyAds(ex).filter(a => a.side === side)) {
    const found = store.findAdCfg(ex, ad.id);
    if (!found?.cfg?.enabled) continue;                       // chỉ ads đang bật Auto Repricing
    if (ad.online === false) continue;                         // bỏ ads đang offline
    const b = store.boundsOf(found.cfg, isBuy);
    const boundary = isBuy ? b.ceiling : b.floor;
    const row = { adId: ad.id, adPrice: ad.price, boundary, floor: b.floor, ceiling: b.ceiling, diff: null, breach: false, alertStatus: 'ok', alertId: null };
    if (boundary === null) { row.alertStatus = 'no-boundary'; rows.push(row); continue; }
    if (!best) { row.alertStatus = 'no-competitor'; resolve(ex, side, ad.id); rows.push(row); continue; }
    row.diff = best.price - boundary;                          // BUY: dương = đối thủ cao hơn trần · SELL: âm = đối thủ thấp hơn sàn
    row.breach = isBuy ? boundary < best.price : boundary > best.price;
    if (!row.breach) { row.alertStatus = resolve(ex, side, ad.id) ? 'resolved' : 'ok'; rows.push(row); continue; }
    const d = decide(ex, side, ad.id, boundary, best.price, g, now);
    row.alertStatus = d.status;
    if (d.send) {
      const alert = makeAlert(ex, side, ad, boundary, best, eligible.length, items.length, snapId, at, d.reason);
      row.alertId = alert.id;
    }
    rows.push(row);
  }

  const prevRt = runtime[key] || {};
  runtime[key] = {
    ex, side, enabled: true, lastScanAt: at, snapId, trigger, staleSince: null,
    // giữ lỗi nếu lỗi xảy ra SAU lượt quét đang đánh giá
    lastError: prevRt.lastErrorAt && prevRt.lastErrorAt > at ? prevRt.lastError : null,
    lastErrorAt: prevRt.lastErrorAt && prevRt.lastErrorAt > at ? prevRt.lastErrorAt : null,
    best: competitorSummary(best), eligibleCount: eligible.length, totalCount: items.length,
    filters: { refLimitMin: c.refLimitMin, refLimitMax: c.refLimitMax, onlineOnly, noNationalLimit, ownAdsExcluded: true, whitelistExcluded: true },
    refPrice: c.refPrice, refDiff: best && c.refPrice !== null ? best.price - c.refPrice : null,
    ads: rows, evaluatedAt: now,
  };
  for (const row of rows) {
    if (row.alertStatus === 'ok' || row.alertStatus === 'no-boundary') continue;
    pushHistory({ at: now, ex, side, adId: row.adId, boundary: row.boundary, best: best?.price ?? null, diff: row.diff, alertStatus: row.alertStatus, alertId: row.alertId, scanAt: at });
  }
  if (!rows.some(r => r.alertStatus !== 'ok' && r.alertStatus !== 'no-boundary')) pushHistory({ at: now, ex, side, adId: null, boundary: null, best: best?.price ?? null, diff: null, alertStatus: rows.length ? 'ok' : 'no-monitored-ads', scanAt: at }, true);
  emitState(ex, side);
  return runtime[key];
}

/** Quyết định có gửi cảnh báo không (chống gửi lặp) */
function decide(ex, side, adId, boundary, bestPrice, g, now) {
  const k = `${ex}:${side}:${adId}`;
  const s = alertState.get(k) || { active: false, lastAlertAt: 0, lastAlertPrice: null, lastBoundary: null, pending: false, ignoredPrice: null };
  const cooldownMs = g.cooldownMin * 60000;
  let reason = null;
  if (!s.active) reason = 'new';                                                     // điều kiện vừa xuất hiện (lần đầu / sau khi đã hết)
  else if (s.pending) reason = 'pending';                                            // lần trước bị chặn bởi thời gian chờ
  else if (s.lastBoundary !== boundary) reason = 'boundary-changed';
  else if (s.lastAlertPrice !== null && Math.abs(bestPrice - s.lastAlertPrice) >= Math.max(g.minChangeVnd, 0.000001)) reason = 'price-changed';
  s.active = true;

  let out;
  if (!reason) out = { send: false, status: 'active' };
  else if (s.ignoredPrice !== null && reason !== 'boundary-changed' && Math.abs(bestPrice - s.ignoredPrice) < Math.max(g.minChangeVnd, 0.000001)) {
    s.pending = false;
    out = { send: false, status: 'ignored' };
  } else if (s.lastAlertAt && now - s.lastAlertAt < cooldownMs) {
    s.pending = true;
    out = { send: false, status: 'cooldown' };
  } else {
    s.pending = false; s.ignoredPrice = null;
    s.lastAlertAt = now; s.lastAlertPrice = bestPrice; s.lastBoundary = boundary;
    out = { send: true, status: 'alert-sent', reason };
  }
  alertState.set(k, s);
  return out;
}

function resolve(ex, side, adId) {
  const k = `${ex}:${side}:${adId}`;
  const s = alertState.get(k);
  if (!s?.active) return false;
  s.active = false; s.pending = false; s.ignoredPrice = null;
  logEvent({ type: 'resolved', ex, side, adId });
  return true;
}

function clearSide(ex, side) {
  for (const k of [...alertState.keys()]) if (k.startsWith(`${ex}:${side}:`)) alertState.delete(k);
  runtime[`${ex}:${side}`] = { ...(runtime[`${ex}:${side}`] || {}), ex, side, enabled: false, ads: [] };
}

function makeAlert(ex, side, ad, boundary, best, eligibleCount, totalCount, snapId, scanAt, reason) {
  const id = (++alertSeq).toString(36) + Date.now().toString(36).slice(-3);
  const alert = {
    id, ex, side, adId: ad.id, adPrice: ad.price, boundary, best: best.price, diff: best.price - boundary,
    boundaryParam: side === 'BUY' ? 'ceiling' : 'floor',
    competitor: competitorSummary(best), eligibleCount, totalCount, snapId, scanAt, at: Date.now(), reason,
    engineRunning: !!engine.statusOf(ex).running, delivery: 'pending',
  };
  alerts.set(id, alert);
  if (alerts.size > 300) alerts.delete(alerts.keys().next().value);
  audit.record({ exchange: ex, adId: ad.id, parameter: `competitionAlert.${side}`, previous: boundary, next: best.price, source: 'engine', status: 'success', message: `${side === 'BUY' ? 'Trần MUA < Best BUY' : 'Sàn BÁN > Best SELL'} (${best.name}) · lệch ${fmtN(best.price - boundary)} VND` });
  logEvent({ type: 'alert', ...alert, competitor: alert.competitor });
  bus.emit('competitionAlert', alert);
  return alert;
}

function markDelivery(id, ok, error) {
  const a = alerts.get(id);
  if (!a) return;
  a.delivery = ok ? 'telegram-sent' : `telegram-failed${error ? `: ${error}` : ''}`;
  const h = history.find(x => x.alertId === id);
  if (h) h.delivery = a.delivery;
}

/** Bỏ qua cảnh báo: không báo lại cho đến khi giá đối thủ đổi ≥ ngưỡng, hoặc điều kiện hết rồi xuất hiện lại */
function ignore(alertId, meta = {}) {
  const a = alerts.get(alertId);
  if (!a) return { ok: false, error: 'Cảnh báo không còn (đã quá cũ)' };
  const s = alertState.get(`${a.ex}:${a.side}:${a.adId}`);
  if (s) { s.ignoredPrice = a.best; s.pending = false; }
  logEvent({ type: 'ignored', ex: a.ex, side: a.side, adId: a.adId, alertId, source: meta.source || 'telegram' });
  return { ok: true };
}

function getAlert(id) { return alerts.get(String(id)) || null; }

// ══════════════════════════════════════════════════════════
// LẤY DỮ LIỆU — dùng chung lượt quét
// ══════════════════════════════════════════════════════════
/**
 * Đánh giá lại trên lượt quét gần nhất đã có (KHÔNG gọi API sàn).
 * Lượt quét quá cũ → không đánh giá, đánh dấu chờ lượt quét mới của Auto Pricing.
 */
async function reevalLatest(ex, side) {
  const k = `${ex}:${side}`;
  if (!sideCfg(ex, side).enabled) return null;
  const last = market.latest(ex, side);
  const rt = runtime[k] || {};
  // Lượt quét mới nhất bị lỗi → bản cache còn lại đã cũ hơn lỗi đó → không đánh giá trên dữ liệu cũ
  if (last && rt.lastErrorAt && rt.lastErrorAt > last.at) { emitState(ex, side); return null; }
  if (!last || Date.now() - last.at > reevalMaxAge(ex)) {
    runtime[k] = { ...(runtime[k] || {}), ex, side, enabled: true, staleSince: last?.at || null };
    emitState(ex, side);
    return null;
  }
  await runEval(ex, side, last.items, { at: last.at, snapId: last.snapId, trigger: 'reeval' });
  return last;
}

async function runEval(ex, side, items, meta) {
  const k = `${ex}:${side}`;
  const st = evaluating.get(k) || { running: false, next: null };
  evaluating.set(k, st);
  if (st.running) { st.next = { items, meta }; return; }   // đang đánh giá → chỉ giữ lượt quét mới nhất
  st.running = true;
  try {
    let job = { items, meta };
    while (job) {
      st.next = null;
      try { await evaluate(ex, side, job.items, job.meta); } catch (err) { logger.error(`[Competition] ${k}: ${err.message}`); }
      job = st.next;
    }
  } finally { st.running = false; }
}

/** Đánh giá lại thủ công (Telegram / web) trên lượt quét gần nhất — không gọi API sàn */
async function refresh(ex, side) {
  const targets = [];
  for (const e of ex ? [ex] : EXS) for (const s of side ? [side] : SIDES) if (sideCfg(e, s).enabled) targets.push([e, s]);
  await Promise.all(targets.map(([e, s]) => reevalLatest(e, s).catch(() => null)));
  // chờ lượt đánh giá đang chạy xong
  for (let i = 0; i < 40 && targets.some(([e, s]) => evaluating.get(`${e}:${s}`)?.running); i++) await new Promise(r => setTimeout(r, 50));
  return snapshot();
}

// ══════════════════════════════════════════════════════════
// TRẠNG THÁI / NHẬT KÝ
// ══════════════════════════════════════════════════════════
function pushHistory(row, collapse = false) {
  if (collapse) {
    const last = history[history.length - 1];
    if (last && last.ex === row.ex && last.side === row.side && last.adId === null && last.alertStatus === row.alertStatus) { Object.assign(last, row); return; }
  }
  history.push(row);
  if (history.length > HISTORY_MAX) history.shift();
}

function logEvent(e) {
  try {
    try { if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch (_) {}
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
  } catch (err) { logger.debug(`[Competition] Không ghi được log: ${err.message}`); }
}

function sideState(ex, side) {
  const c = sideCfg(ex, side);
  const rt = runtime[`${ex}:${side}`] || {};
  return {
    ex, side, label: LABEL[ex], ...c,
    lastScanAt: c.enabled ? rt.lastScanAt || null : null, lastError: rt.lastError || null, lastErrorAt: rt.lastErrorAt || null,
    best: c.enabled ? rt.best || null : null, eligibleCount: rt.eligibleCount ?? null, totalCount: rt.totalCount ?? null,
    refDiff: c.enabled && rt.best && c.refPrice !== null ? rt.best.price - c.refPrice : null,
    ads: c.enabled ? rt.ads || [] : [],
    connected: adapters.get(ex).isConnected(), engineRunning: !!engine.statusOf(ex).running,
    waiting: c.enabled ? waitingReason(ex, side, rt) : null,
  };
}

/** Vì sao chưa có / không có dữ liệu mới (theo dõi chỉ cập nhật khi Auto Pricing quét) */
function waitingReason(ex, side, rt) {
  const running = !!engine.statusOf(ex).running;
  const fresh = rt.lastScanAt && Date.now() - rt.lastScanAt <= reevalMaxAge(ex);
  if (fresh && !rt.staleSince) return null;
  if (!running) return rt.lastScanAt ? 'Auto Pricing đang dừng — dữ liệu cũ, chờ Auto Pricing chạy để cập nhật' : 'Auto Pricing đang dừng — chưa có lượt quét nào';
  return 'Đang chờ lượt quét kế tiếp của Auto Pricing';
}

function snapshot() {
  const g = config();
  const out = { cooldownMin: g.cooldownMin, minChangeVnd: g.minChangeVnd, exchanges: {} };
  for (const ex of EXS) out.exchanges[ex] = { BUY: sideState(ex, 'BUY'), SELL: sideState(ex, 'SELL') };
  return out;
}

function emitState(ex, side, meta = {}) {
  bus.emit('competition', { type: 'state', ex, side, state: sideState(ex, side), source: meta.source, client: meta.client });
}

function recentHistory(limit = 100) { return history.slice(-Math.min(HISTORY_MAX, limit)).reverse(); }

// ══════════════════════════════════════════════════════════
// KẾT NỐI VỚI LƯỢT QUÉT MARKET
// ══════════════════════════════════════════════════════════
bus.on('marketScan', ev => {
  if (!EXS.includes(ev.ex) || !sideCfg(ev.ex, ev.side).enabled) return;
  runEval(ev.ex, ev.side, ev.items, { at: ev.at, snapId: ev.snapId, trigger: 'scan' });
});
bus.on('marketScanError', ev => {
  if (!EXS.includes(ev.ex) || !sideCfg(ev.ex, ev.side).enabled) return;
  const k = `${ev.ex}:${ev.side}`;
  runtime[k] = { ...(runtime[k] || {}), ex: ev.ex, side: ev.side, lastError: ev.error, lastErrorAt: ev.at };
  pushHistory({ at: ev.at, ex: ev.ex, side: ev.side, adId: null, boundary: null, best: null, diff: null, alertStatus: 'scan-error', error: ev.error }, true);
  emitState(ev.ex, ev.side);
});
// Trần/sàn/bật-tắt ad đổi (web/Telegram) → đánh giá lại trên lượt quét gần nhất
const reevalTimers = {};
bus.on('config', ev => {
  if (!EXS.includes(ev?.ex) || ev.scope === 'settings') return;
  clearTimeout(reevalTimers[ev.ex]);
  reevalTimers[ev.ex] = setTimeout(() => {
    for (const side of SIDES) if (sideCfg(ev.ex, side).enabled) reevalLatest(ev.ex, side).catch(() => {});
  }, 300);
});


module.exports = {
  EXS, SIDES, config, setSideConfig, setGlobal, snapshot, sideState, refresh, getAlert, ignore, markDelivery,
  recentHistory, evaluate, _alertState: alertState,
};
