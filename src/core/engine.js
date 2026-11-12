/**
 * ENGINE TỰ CHỈNH GIÁ — chạy trên server (máy của bạn), dùng chung cho web và Telegram.
 *
 *  - Mỗi sàn đúng 1 worker (không chạy chồng vòng quét, không tạo worker trùng)
 *  - Logic từng sàn port nguyên từ engine cũ trong trình duyệt (app.js)
 *  - Thêm: kẹp giá trong [Sàn, Trần]; trạng thái Running / Paused / Error;
 *          khoá theo ad khi gửi cập nhật; không cập nhật khi thiếu dữ liệu market/ads
 *  - Cấu hình đọc trực tiếp từ store mỗi vòng → thay đổi từ web/Telegram có hiệu lực ngay
 */
const bus = require('./bus');
const store = require('./store');
const adapters = require('./adapters');
const market = require('./market');
const whitelist = require('../services/whitelist');
const logger = require('../utils/logger');
const { withLock, sleep, num, isBlank, fmt, shortId } = require('./util');

const EXCHANGES = ['mexc', 'bitget', 'bybit', 'bingx'];
const MIN_INTERVAL = { mexc: 5, bitget: 1, bybit: 1, bingx: 5 };
const BY_BUY_REFILL_QTY = 20000;
const MY_ADS_MAX_AGE = { mexc: 0, bitget: 60000, bybit: 0, bingx: 0 };   // engine làm mới ads của tôi mỗi vòng

class Worker {
  constructor(ex) {
    this.ex = ex;
    this.running = false;
    this.timer = null;
    this.busy = false;
    this.error = null;            // lỗi của vòng gần nhất (null = OK)
    this.lastCycleAt = null;
    this.lastCycleOkAt = null;
    this.lastPriceUpdateAt = null;
    this.updates = 0;
    this.logs = [];
    this.rowStatus = {};          // key → { msg, type, at, target, current }
    this.myAds = [];              // ads của tôi (chuẩn hoá) — nguồn dữ liệu chung cho web & Telegram
    this.myAdsAt = null;
    this.myAdsError = null;
    this.pending = new Set();     // key cần tính lại ngay sau vòng hiện tại
    this.gen = 0;                 // thế hệ worker: mỗi lần Bật/Dừng tăng 1 → vòng cũ không tự lên lịch lại (chống worker trùng)
  }
}

const workers = Object.fromEntries(EXCHANGES.map(ex => [ex, new Worker(ex)]));

// ── Log / trạng thái ──────────────────────────────────────
function log(ex, msg, type = '') {
  const w = workers[ex];
  const entry = { ex, msg, type, at: Date.now() };
  w.logs.unshift(entry);
  if (w.logs.length > 200) w.logs.pop();
  bus.emit('log', entry);
  if (type === 'error') logger.warn(`[Engine:${ex}] ${msg}`);
}
function setRow(ex, key, msg, type = '', extra = {}) {
  const st = { msg, type, at: Date.now(), ...extra };
  workers[ex].rowStatus[key] = st;
  bus.emit('rowStatus', { ex, key, ...st });
}

function statusOf(ex) {
  const w = workers[ex];
  const sec = store.section(ex);
  const a = adapters.get(ex);
  const state = !w.running ? 'paused' : (w.error ? 'error' : 'running');
  return {
    ex, running: w.running, state, busy: w.busy, error: w.error,
    connected: a.isConnected(), market: a.marketReady(),
    interval: Math.max(MIN_INTERVAL[ex], Number(sec.scanInterval) || 30),
    lastCycleAt: w.lastCycleAt, lastCycleOkAt: w.lastCycleOkAt, lastPriceUpdateAt: w.lastPriceUpdateAt,
    updates: w.updates, enabledCount: enabledKeys(ex).length,
    myAdsAt: w.myAdsAt, myAdsError: w.myAdsError, myAdsCount: w.myAds.length,
    marketStatus: market.status(ex),
  };
}
function emitStatus(ex) { bus.emit('engine', statusOf(ex)); }

function enabledKeys(ex) {
  const sec = store.section(ex);
  if (ex === 'mexc') return Object.entries(sec.apConfigs).filter(([, c]) => c.enabled).map(([k]) => k);
  if (ex === 'bingx') return Object.entries(sec.configs).filter(([, c]) => c.enabled).map(([k]) => k);
  return sec.rows.filter(r => r.enabled && r.advId).map(r => r.id);
}

// ── Ads của tôi (nguồn dữ liệu chung) ─────────────────────
async function refreshMyAds(ex, { maxAgeMs = 0 } = {}) {
  const w = workers[ex];
  if (maxAgeMs > 0 && w.myAdsAt && Date.now() - w.myAdsAt <= maxAgeMs && !w.myAdsError) return { ok: true, items: w.myAds, cached: true };
  const r = await adapters.get(ex).fetchMyAds();
  if (r.ok) {
    w.myAds = r.items; w.myAdsAt = Date.now(); w.myAdsError = null;
    market.setMyAdIds(ex, r.items.map(a => a.id));
    bus.emit('ads', { ex, at: w.myAdsAt, count: r.items.length });
  } else {
    w.myAdsError = r.error;
  }
  return r;
}
function getMyAds(ex) { return workers[ex].myAds; }
market.setMyAdsLoader(ex => refreshMyAds(ex, { maxAgeMs: 60000 }));

// ── Kẹp giá trong [Sàn, Trần] ─────────────────────────────
function clampToBounds(price, cfg, isBuy) {
  const { floor, ceiling } = store.boundsOf(cfg, isBuy);
  if (floor !== null && ceiling !== null && floor > ceiling) return { error: `Sàn (${fmt(floor)}) > Trần (${fmt(ceiling)}) — sửa cấu hình` };
  let p = price;
  if (ceiling !== null && p > ceiling) p = ceiling;
  if (floor !== null && p < floor) p = floor;
  return { price: p, floor, ceiling };
}
const legacyLimit = cfg => (isBlank(cfg.priceLimit) || isNaN(parseFloat(cfg.priceLimit))) ? null : parseFloat(cfg.priceLimit);

// ══════════════════════════════════════════════════════════
// MEXC — port từ apRunCycle / apFindBestPrice
// ══════════════════════════════════════════════════════════
function mexcPick(items, cfg, isBuy, selfAdvNo) {
  const now = Date.now();
  const lim = legacyLimit(cfg);
  const reqAmount = parseFloat(cfg.amount) || 0;
  const wl = new Set(whitelist.getWhitelist().map(n => n.toLowerCase()));
  const mine = new Set(getMyAds('mexc').map(a => a.id));
  const f = {
    onlineMinutes: num(cfg.onlineMinutes) || 0,
    tradeMin: num(cfg.userAllTradeCountMin) || 0, tradeMax: num(cfg.userAllTradeCountMax) || 0,
    maxCap: num(cfg.filterMaxSingleTransAmount) || 0,
  };
  let best = null;
  for (const m of items) {
    const raw = m.raw;
    if (mine.has(m.id) || String(m.id) === String(selfAdvNo)) continue;
    const p = m.price;
    if (p === null) continue;
    if (m.name && wl.has(m.name.toLowerCase())) continue;
    if (f.onlineMinutes > 0) {
      const last = m.lastOnline;
      if (!last || (now - last) / 60000 > f.onlineMinutes) continue;
    }
    if (f.tradeMin > 0 && raw.userAllTradeCountMin < f.tradeMin) continue;
    if (f.tradeMax > 0 && raw.userAllTradeCountMax < f.tradeMax) continue;
    if (f.maxCap > 0 && raw.maxSingleTransAmount < f.maxCap) continue;
    if (lim !== null) { if (isBuy && p > lim) continue; if (!isBuy && p < lim) continue; }
    if (reqAmount > 0) {
      if (m.min !== null && reqAmount < m.min) continue;
      if (m.max !== null && reqAmount > m.max) continue;
    }
    if (best === null || (isBuy ? p > best : p < best)) best = p;
  }
  return best;
}

async function cycleMexc(ctx) {
  const a = adapters.get('mexc');
  const ads = await refreshMyAds('mexc');
  if (!ads.ok) throw new Error(`Không lấy được ads của tôi: ${ads.error}`);
  const sec = store.section('mexc');
  const active = ads.items.filter(ad => sec.apConfigs[ad.id]?.enabled && ctx.want(ad.id));
  if (!active.length) return;

  let buyMarket = [], sellMarket = [];
  if (active.some(ad => ad.side === 'BUY')) {
    const r = await market.get('mexc', 'BUY', { maxAgeMs: ctx.marketMaxAge, opts: { pages: 10 } });
    if (!r.ok) throw new Error(`Lỗi market BUY: ${r.error}`);
    buyMarket = r.items; ctx.log(`Market BUY: ${buyMarket.length} ads${r.cached ? ' (cache)' : ''}`);
    if (!r.cached) await sleep(1200);
  }
  if (active.some(ad => ad.side === 'SELL')) {
    const r = await market.get('mexc', 'SELL', { maxAgeMs: ctx.marketMaxAge, opts: { pages: 10 } });
    if (!r.ok) throw new Error(`Lỗi market SELL: ${r.error}`);
    sellMarket = r.items; ctx.log(`Market SELL: ${sellMarket.length} ads${r.cached ? ' (cache)' : ''}`);
    if (!r.cached) await sleep(1200);
  }

  let changed = false;
  for (const ad of active) {
    if (!ctx.alive()) break;
    const cfg = sec.apConfigs[ad.id];
    const isBuy = ad.side === 'BUY';
    ctx.status(ad.id, 'Đang quét...');
    try {
      const best = mexcPick(isBuy ? buyMarket : sellMarket, cfg, isBuy, ad.id);
      if (best === null) { ctx.status(ad.id, 'Không tìm được giá', 'warn'); ctx.log(`[${shortId(ad.id)}] Không tìm được giá tốt nhất trong khung`, 'warn'); continue; }
      let newPrice = best + (parseFloat(cfg.offset) || 0);
      const lim = legacyLimit(cfg);
      if (lim !== null) { if (isBuy && newPrice > lim) newPrice = lim; if (!isBuy && newPrice < lim) newPrice = lim; }
      newPrice = Math.round(newPrice);
      const b = clampToBounds(newPrice, cfg, isBuy);
      if (b.error) { ctx.status(ad.id, b.error, 'err'); ctx.log(`[${shortId(ad.id)}] ${b.error}`, 'error'); continue; }
      newPrice = Math.round(b.price);
      const current = ad.price;
      ctx.result(ad.id, { target: newPrice, current, best });
      if (newPrice === current) { ctx.status(ad.id, `Giá OK: ${fmt(current)}`, 'ok', { target: newPrice, current }); continue; }
      if (ctx.dryRun) { ctx.status(ad.id, `Giá mục tiêu: ${fmt(newPrice)} (chưa áp dụng)`, '', { target: newPrice, current }); continue; }

      let refill = null;
      if (!isBlank(cfg.refillThreshold) && !isBlank(cfg.refillQuantity)) {
        const avail = ad.available || 0;
        if (avail < parseFloat(cfg.refillThreshold)) {
          refill = { avail, quantity: parseFloat(cfg.refillQuantity) };
          ctx.log(`[${shortId(ad.id)}] Refill: ${avail} < ${cfg.refillThreshold} → supplyQuantity=${cfg.refillQuantity}`, 'warn');
        }
      }
      const payload = a.buildPayload(ad, cfg, { price: newPrice, refill });
      const r = await withLock(`mexc:${ad.id}`, () => a.sendUpdate(payload));
      if (r.ok) {
        ad.price = newPrice; ad.raw.price = newPrice; changed = true;
        ctx.updated(ad.id, newPrice);
        ctx.status(ad.id, `Đã cập nhật → ${fmt(newPrice)}`, 'ok', { target: newPrice, current: newPrice });
        ctx.log(`[${shortId(ad.id)}] ${ad.side} | Best: ${fmt(best)} | Mới: ${fmt(newPrice)}`, 'success');
      } else {
        ctx.status(ad.id, `Lỗi: ${r.msg}`, 'err'); ctx.log(`[${shortId(ad.id)}] Lỗi API: ${r.msg}`, 'error');
        ctx.updateFailed(r);
      }
    } catch (err) {
      ctx.status(ad.id, `Lỗi: ${err.message}`, 'err'); ctx.log(`[${shortId(ad.id)}] Exception: ${err.message}`, 'error');
    }
  }
  if (changed) await refreshMyAds('mexc');
}

// ══════════════════════════════════════════════════════════
// BITGET — port từ bgRunCycle / bgFindBestMarketPrice
// ══════════════════════════════════════════════════════════
function bitgetPick(items, { selfAdvId, priceLimit, isBuy, reqAmount }) {
  const lim = isBlank(priceLimit) || isNaN(parseFloat(priceLimit)) ? null : parseFloat(priceLimit);
  const wl = new Set(whitelist.getWhitelist().map(n => n.toLowerCase()));
  let best = null;
  for (const m of items) {
    if (selfAdvId && String(m.id) === String(selfAdvId)) continue;
    const p = m.price;
    if (p === null) continue;
    if (m.name && wl.has(m.name.toLowerCase())) continue;
    if (lim !== null) { if (isBuy && p > lim) continue; if (!isBuy && p < lim) continue; }
    if (reqAmount > 0) {
      // Trần giao dịch THỰC của đối thủ = min(maxAmount, số lượng còn × giá)
      const declared = m.max, byQty = m.available !== null ? m.available * p : null;
      let eff = null;
      if (declared !== null && byQty !== null) eff = Math.min(declared, byQty);
      else eff = declared ?? byQty;
      if (eff !== null && eff < reqAmount) continue;
    }
    if (best === null || (isBuy ? p > best : p < best)) best = p;
  }
  return best;
}

async function cycleBitget(ctx) {
  const a = adapters.get('bitget');
  const sec = store.section('bitget');
  const rows = dedupeRows('bitget', sec.rows.filter(r => r.enabled && r.advId && ctx.want(r.id)), ctx);
  await refreshMyAds('bitget', { maxAgeMs: MY_ADS_MAX_AGE.bitget }).catch(() => {});
  if (!rows.length) return;
  const offsetBuy = parseFloat(sec.offsetBuy) || 0, offsetSell = parseFloat(sec.offsetSell) || 0;
  const cycleCache = {};
  let marketOk = false;

  for (const row of rows) {
    if (!ctx.alive()) break;
    const isBuy = row.side === 'buy';
    ctx.status(row.id, 'Đang quét...');
    try {
      const amount = !isBlank(row.searchAmount) ? row.searchAmount : (sec.filterAmount || '');
      const mSide = isBuy ? 'BUY' : 'SELL';   // ad MUA so với ads MUA của merchant (side 'sell' của Bitget)
      const ck = `${mSide}|${amount}`;
      if (!cycleCache[ck]) {
        const r = await market.get('bitget', mSide, { maxAgeMs: ctx.marketMaxAge, opts: { amount: amount ? String(amount) : '', pages: 1 } });
        if (!r.ok) { ctx.status(row.id, `Lỗi lấy giá: ${r.error}`, 'err'); ctx.log(`[${shortId(row.advId)}] lỗi giá market: ${r.error}`, 'error'); ctx.marketFailed(r.error); continue; }
        cycleCache[ck] = r.items; marketOk = true;
      }
      const reqAmount = !isBlank(row.searchAmount) && !isNaN(parseFloat(row.searchAmount)) ? parseFloat(row.searchAmount) : 0;
      const ref = bitgetPick(cycleCache[ck], { selfAdvId: row.advId, priceLimit: row.priceLimit, isBuy, reqAmount });
      if (ref === null) { ctx.status(row.id, 'Chưa có giá market', 'warn'); ctx.log(`[${shortId(row.advId)}] Chưa lấy được giá ${isBuy ? 'SELL' : 'BUY'} market`, 'warn'); continue; }

      const info = await a.fetchAdInfo(row.advId);
      if (!info.ok) { ctx.status(row.id, `Lỗi ad-info: ${info.error}`, 'err'); ctx.log(`[${shortId(row.advId)}] ad-info lỗi: ${info.error}`, 'error'); continue; }
      const ad = info.ad;
      const currentPrice = ad.price, currentAvailable = ad.available || 0;
      const rowOffset = !isBlank(row.offset) && !isNaN(parseFloat(row.offset)) ? parseFloat(row.offset) : (isBuy ? offsetBuy : offsetSell);
      let newPrice = ref + rowOffset;
      const lim = legacyLimit(row);
      if (lim !== null) { if (isBuy && newPrice > lim) newPrice = lim; if (!isBuy && newPrice < lim) newPrice = lim; }
      newPrice = Math.round(newPrice);
      const b = clampToBounds(newPrice, row, isBuy);
      if (b.error) { ctx.status(row.id, b.error, 'err'); ctx.log(`[${shortId(row.advId)}] ${b.error}`, 'error'); continue; }
      newPrice = Math.round(b.price);

      let quantity = !isBlank(row.quantity) ? parseFloat(row.quantity) : currentAvailable;
      const hasRefill = !isBlank(row.refillThreshold) && !isBlank(row.refillQuantity);
      const needRefill = hasRefill && currentAvailable < parseFloat(row.refillThreshold);
      if (needRefill && !isNaN(parseFloat(row.refillQuantity))) {
        quantity = parseFloat(row.refillQuantity);
        ctx.log(`[${shortId(row.advId)}] Refill: còn ${fmt(currentAvailable)} < ${fmt(row.refillThreshold)} → SL=${fmt(quantity)}`, 'warn');
      }
      ctx.result(row.id, { target: newPrice, current: currentPrice, best: ref });
      if (newPrice === Math.round(currentPrice) && !needRefill) { ctx.status(row.id, `Giá OK: ${fmt(currentPrice)}`, 'ok', { target: newPrice, current: currentPrice }); continue; }
      if (ctx.dryRun) { ctx.status(row.id, `Giá mục tiêu: ${fmt(newPrice)} (chưa áp dụng)`, '', { target: newPrice, current: currentPrice }); continue; }

      const payload = a.buildPayload(ad, row, { price: newPrice, quantity });
      const r = await withLock(`bitget:${row.advId}`, () => a.sendUpdate(payload));
      if (r.ok) {
        ctx.updated(row.id, newPrice);
        ctx.status(row.id, `→ ${fmt(newPrice)} | SL ${fmt(quantity, 4)}`, 'ok', { target: newPrice, current: newPrice });
        ctx.log(`[${shortId(row.advId)}] ${row.side.toUpperCase()} | ref ${isBuy ? 'SELL' : 'BUY'}: ${fmt(ref)} +${rowOffset} → ${fmt(newPrice)} | SL=${fmt(quantity, 4)} | max=${fmt(payload.maxAmount)}`, 'success');
      } else {
        ctx.status(row.id, `Lỗi: ${r.msg}`, 'err'); ctx.log(`[${shortId(row.advId)}] update lỗi: ${r.msg}`, 'error');
        ctx.updateFailed(r);
      }
    } catch (err) {
      ctx.status(row.id, `Lỗi: ${err.message}`, 'err'); ctx.log(`[${shortId(row.advId)}] ${err.message}`, 'error');
    }
  }
  if (marketOk) market.recordOk('bitget');
  if (ctx.anyUpdated()) await refreshMyAds('bitget').catch(() => {});
}

// ══════════════════════════════════════════════════════════
// BYBIT — port từ byRunCycle / byPickBest
// ══════════════════════════════════════════════════════════
function bybitPick(items, { reqAmount, priceLimit, isBuy, selfId, onlineOnly }) {
  const lim = isBlank(priceLimit) || isNaN(parseFloat(priceLimit)) ? null : parseFloat(priceLimit);
  const wl = new Set(whitelist.getWhitelist().map(n => n.toLowerCase()));
  let best = null;
  for (const m of items) {
    if (selfId && String(m.id) === String(selfId)) continue;
    if (onlineOnly && m.online !== true) continue;
    const p = m.price;
    if (p === null) continue;
    if (m.name && wl.has(m.name.toLowerCase())) continue;
    if (lim !== null) { if (isBuy && p > lim) continue; if (!isBuy && p < lim) continue; }
    if (reqAmount > 0) {
      if (m.min !== null && reqAmount < m.min) continue;
      if (m.max !== null && reqAmount > m.max) continue;
    }
    if (best === null || (isBuy ? p > best : p < best)) best = p;
  }
  return best;
}

async function cycleBybit(ctx) {
  const a = adapters.get('bybit');
  const sec = store.section('bybit');
  const rows = dedupeRows('bybit', sec.rows.filter(r => r.enabled && r.advId && ctx.want(r.id)), ctx);
  if (!rows.length) { await refreshMyAds('bybit', { maxAgeMs: 60000 }).catch(() => {}); return; }
  const ads = await refreshMyAds('bybit');
  if (!ads.ok) throw new Error(`Không lấy được ads của tôi: ${ads.error}`);

  let buyMarket = [], sellMarket = [];
  if (rows.some(r => r.side === 'buy')) {
    const r = await market.get('bybit', 'BUY', { maxAgeMs: ctx.marketMaxAge, opts: {} });
    if (!r.ok) throw new Error(`Lỗi market BUY: ${r.error}`);
    buyMarket = r.items; ctx.log(`Market BUY: ${buyMarket.length} ads${r.cached ? ' (cache)' : ''}`);
  }
  if (rows.some(r => r.side === 'sell')) {
    const r = await market.get('bybit', 'SELL', { maxAgeMs: ctx.marketMaxAge, opts: {} });
    if (!r.ok) throw new Error(`Lỗi market SELL: ${r.error}`);
    sellMarket = r.items; ctx.log(`Market SELL: ${sellMarket.length} ads${r.cached ? ' (cache)' : ''}`);
  }
  const onlineOnly = sec.onlineOnly !== false;

  for (const row of rows) {
    if (!ctx.alive()) break;
    const isBuy = row.side === 'buy';
    ctx.status(row.id, 'Đang quét...');
    try {
      const items = isBuy ? buyMarket : sellMarket;
      if (!items.length) { ctx.status(row.id, 'Market rỗng', 'warn'); continue; }
      const ref = bybitPick(items, { reqAmount: parseFloat(row.searchAmount) || 0, priceLimit: row.priceLimit, isBuy, selfId: row.advId, onlineOnly });
      if (ref === null) { ctx.status(row.id, 'Không có giá phù hợp', 'warn'); continue; }
      const offset = parseFloat(row.offset) || 0;
      let newPrice = ref + offset;
      const lim = legacyLimit(row);
      if (lim !== null) { if (isBuy && newPrice > lim) newPrice = lim; if (!isBuy && newPrice < lim) newPrice = lim; }

      const ad = ads.items.find(x => x.id === String(row.advId));
      if (!ad) { ctx.status(row.id, 'Ad không còn trên sàn (đã xóa?)', 'err'); ctx.log(`[${shortId(row.advId)}] Không thấy ad trong My Ads — có thể đã bị xóa/sửa ngoài tool`, 'error'); continue; }
      const b = clampToBounds(newPrice, row, isBuy);
      if (b.error) { ctx.status(row.id, b.error, 'err'); ctx.log(`[${shortId(row.advId)}] ${b.error}`, 'error'); continue; }
      const scale = ad.raw.symbolInfo?.currency?.scale ?? 2;
      const newPriceStr = (+b.price).toFixed(scale);
      const currentStr = (+ad.price).toFixed(scale);
      const manualRefill = (parseFloat(row.refill) || 0) > 0;
      ctx.result(row.id, { target: +newPriceStr, current: ad.price, best: ref });
      if (newPriceStr === currentStr && !manualRefill) { ctx.status(row.id, `Giá OK: ${currentStr}`, 'ok', { target: +newPriceStr, current: ad.price }); continue; }
      if (ctx.dryRun) { ctx.status(row.id, `Giá mục tiêu: ${newPriceStr} (chưa áp dụng)`, '', { target: +newPriceStr, current: ad.price }); continue; }

      const keepQty = !isBuy || row.qtyMode === 'keep';
      let quantity;
      if (!keepQty) quantity = String(BY_BUY_REFILL_QTY);
      else {
        const avail = (num(ad.raw.lastQuantity) || 0) - (num(ad.raw.frozenQuantity) || 0);
        quantity = String(Math.max(0, avail + (parseFloat(row.refill) || 0)));
        if (parseFloat(quantity) <= 0) ctx.log(`[${shortId(row.advId)}] Số lượng hiện tại = 0 — cân nhắc nhập Refill tay`, 'warn');
      }
      const minAmount = !isBlank(row.minAmount) ? String(row.minAmount) : String(ad.raw.minAmount ?? '');
      const maxAmount = !isBlank(row.maxAmount) ? String(row.maxAmount) : String(ad.raw.maxAmount ?? '');
      if (!minAmount || !maxAmount) { ctx.status(row.id, 'Thiếu Min/Max — nhập vào dòng', 'err'); ctx.log(`[${shortId(row.advId)}] thiếu minAmount/maxAmount, không update`, 'error'); continue; }

      const payload = a.buildPayload(ad, { price: newPriceStr, quantity, min: minAmount, max: maxAmount });
      const r = await withLock(`bybit:${row.advId}`, () => a.sendUpdate(payload));
      if (r.ok) {
        ad.price = +newPriceStr; ad.raw.price = newPriceStr;
        ctx.updated(row.id, +newPriceStr);
        ctx.status(row.id, `→ ${newPriceStr} | SL ${fmt(quantity, 4)}`, 'ok', { target: +newPriceStr, current: +newPriceStr });
        ctx.log(`[${shortId(row.advId)}] ${row.side.toUpperCase()} ref ${isBuy ? 'BUY' : 'SELL'}: ${ref} +${offset} → ${newPriceStr} | SL=${quantity}`, 'success');
        if (keepQty && manualRefill) store.patchByKey('bybit', row.id, { refill: '' }, { source: 'engine' });
      } else {
        ctx.status(row.id, `Lỗi: ${r.msg}`, 'err'); ctx.log(`[${shortId(row.advId)}] update lỗi: ${r.msg}`, 'error');
        ctx.updateFailed(r);
      }
    } catch (err) {
      ctx.status(row.id, `Lỗi: ${err.message}`, 'err'); ctx.log(`[${shortId(row.advId)}] ${err.message}`, 'error');
    }
  }
}

// ══════════════════════════════════════════════════════════
// BINGX — port từ bxRunCycle / bxPickBest
// ══════════════════════════════════════════════════════════
function bingxPick(items, { isBuy, reqAmount, priceLimit, minTrades30d }) {
  const lim = isBlank(priceLimit) || isNaN(parseFloat(priceLimit)) ? null : parseFloat(priceLimit);
  const wl = new Set(whitelist.getWhitelist().map(n => n.toLowerCase()));
  const mine = new Set(getMyAds('bingx').map(a => a.id));
  let best = null, bestAd = null;
  for (const m of items) {
    if (mine.has(String(m.id))) continue;
    const p = m.price;
    if (p === null) continue;
    if (m.name && wl.has(String(m.name).toLowerCase())) continue;
    if (lim !== null && (isBuy ? p > lim : p < lim)) continue;
    if (reqAmount > 0) {
      if (m.min !== null && reqAmount < m.min) continue;
      if (m.max !== null && reqAmount > m.max) continue;
    }
    if (minTrades30d > 0 && (m.trades30d || 0) < minTrades30d) continue;
    if (best === null || (isBuy ? p > best : p < best)) { best = p; bestAd = m; }
  }
  return best === null ? null : { price: best, ad: bestAd };
}

async function cycleBingx(ctx) {
  const a = adapters.get('bingx');
  const ads = await refreshMyAds('bingx');
  if (!ads.ok) throw new Error(`Không lấy được ads của tôi: ${ads.error}`);
  const sec = store.section('bingx');
  const active = ads.items.filter(ad => sec.configs[ad.id]?.enabled && ctx.want(ad.id));
  if (!active.length) return;
  const pages = Math.min(10, Math.max(1, parseInt(sec.marketPages) || 3));

  let buyMarket = [], sellMarket = [];
  if (active.some(ad => ad.side === 'BUY')) {
    const r = await market.get('bingx', 'BUY', { maxAgeMs: ctx.marketMaxAge, opts: { pages } });
    if (!r.ok) throw new Error(`Lỗi market MUA: ${r.error}`);
    buyMarket = r.items; ctx.log(`Market MUA: ${buyMarket.length} ads${r.cached ? ' (cache)' : ''}`);
  }
  if (active.some(ad => ad.side === 'SELL')) {
    const r = await market.get('bingx', 'SELL', { maxAgeMs: ctx.marketMaxAge, opts: { pages } });
    if (!r.ok) throw new Error(`Lỗi market BÁN: ${r.error}`);
    sellMarket = r.items; ctx.log(`Market BÁN: ${sellMarket.length} ads${r.cached ? ' (cache)' : ''}`);
  }

  let sent = false;
  for (const ad of active) {
    if (!ctx.alive()) break;
    const cfg = sec.configs[ad.id];
    const isBuy = ad.side === 'BUY';
    ctx.status(ad.id, 'Đang quét...');
    try {
      const best = bingxPick(isBuy ? buyMarket : sellMarket, {
        isBuy, reqAmount: parseFloat(cfg.searchAmount) || 0, priceLimit: cfg.priceLimit, minTrades30d: parseFloat(cfg.minTrades30d) || 0,
      });
      if (!best) { ctx.status(ad.id, 'Không tìm được giá', 'warn'); ctx.log(`[${shortId(ad.id)}] Không có ads đối thủ phù hợp bộ lọc`, 'warn'); continue; }
      let newPrice = best.price + (parseFloat(cfg.offset) || 0);
      const lim = legacyLimit(cfg);
      if (lim !== null) { if (isBuy && newPrice > lim) newPrice = lim; if (!isBuy && newPrice < lim) newPrice = lim; }
      const roundP = p => (ad.fiat || 'VND') === 'VND' ? Math.round(p) : Math.round(p * 100) / 100;
      newPrice = roundP(newPrice);
      const b = clampToBounds(newPrice, cfg, isBuy);
      if (b.error) { ctx.status(ad.id, b.error, 'err'); ctx.log(`[${shortId(ad.id)}] ${b.error}`, 'error'); continue; }
      newPrice = roundP(b.price);
      const current = ad.price;
      ctx.result(ad.id, { target: newPrice, current, best: best.price });
      if (!ad.floating && newPrice === current) { ctx.status(ad.id, `Giá OK: ${fmt(current)}`, 'ok', { target: newPrice, current }); continue; }
      if (ctx.dryRun) { ctx.status(ad.id, `Giá mục tiêu: ${fmt(newPrice)} (chưa áp dụng)`, '', { target: newPrice, current }); continue; }

      if (sent) await sleep(600);   // giới hạn sửa ad BingX: 2 lần/giây
      sent = true;
      // Auto repricing CHỈ đổi giá → 3.19 modifyPrice {advertNo, priceType, fixedPrice}; không gửi Min/Max/SL
      const body = { advertNo: ad.id, price: String(newPrice) };
      const r = await withLock(`bingx:${ad.id}`, () => a.sendUpdate(body));
      if (r.ok) {
        ad.price = newPrice; ad.floating = false;
        ctx.updated(ad.id, newPrice);
        ctx.status(ad.id, `Đã cập nhật → ${fmt(newPrice)}`, 'ok', { target: newPrice, current: newPrice });
        ctx.log(`[${shortId(ad.id)}] ${isBuy ? 'MUA' : 'BÁN'} | Best: ${fmt(best.price)} (${best.ad?.name || '?'}) | ${fmt(current)} → ${fmt(newPrice)}`, 'success');
      } else {
        ctx.status(ad.id, `Lỗi: ${r.msg}`, 'err'); ctx.log(`[${shortId(ad.id)}] Lỗi sửa ad: ${r.msg}`, 'error');
        ctx.updateFailed(r);
      }
    } catch (err) {
      ctx.status(ad.id, `Lỗi: ${err.message}`, 'err'); ctx.log(`[${shortId(ad.id)}] Exception: ${err.message}`, 'error');
    }
  }
}

/** 1 ad chỉ được 1 dòng cấu hình điều khiển — tránh 2 dòng cùng sửa giá 1 ad */
function dedupeRows(ex, rows, ctx) {
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const k = String(r.advId);
    if (seen.has(k)) { ctx.status(r.id, `Trùng ad với dòng #${seen.get(k)} — bỏ qua`, 'warn'); continue; }
    seen.set(k, r.id); out.push(r);
  }
  return out;
}

const CYCLES = { mexc: cycleMexc, bitget: cycleBitget, bybit: cycleBybit, bingx: cycleBingx };

// ══════════════════════════════════════════════════════════
// Điều phối
// ══════════════════════════════════════════════════════════

/**
 * Chạy 1 vòng (hoặc chỉ các key trong onlyKeys).
 * dryRun = true → chỉ tính giá mục tiêu, không gửi lên sàn.
 * Trả về { results: {key: {target, current, best, updated}}, error }
 */
async function runCycle(ex, { onlyKeys = null, dryRun = false, marketMaxAge = 2000 } = {}) {
  const w = workers[ex];
  const results = {};
  let cycleError = null;
  let updated = 0;
  const ctx = {
    dryRun, marketMaxAge,
    want: key => !onlyKeys || onlyKeys.has(String(key)),
    alive: () => dryRun || w.running || !!onlyKeys,
    log: (m, t) => log(ex, m, t),
    status: (key, m, t, extra) => setRow(ex, key, m, t, extra),
    result: (key, r) => { results[key] = { ...(results[key] || {}), ...r }; },
    updated: (key, price) => {
      updated++; w.updates++; w.lastPriceUpdateAt = Date.now();
      results[key] = { ...(results[key] || {}), updated: true, target: price };
    },
    anyUpdated: () => updated > 0,
    updateFailed: r => { if (/not_connected|exception/.test(r.exchangeStatus || '')) cycleError = r.msg; },
    marketFailed: e => { cycleError = e; },
  };
  try {
    if (!adapters.get(ex).isConnected()) throw new Error('Chưa kết nối sàn');
    await CYCLES[ex](ctx);
  } catch (err) {
    cycleError = err.message || String(err);
    log(ex, `Vòng quét lỗi — tạm không cập nhật giá: ${cycleError}`, 'error');
  }
  return { results, error: cycleError, updated };
}

async function loop(ex, gen) {
  const w = workers[ex];
  if (!w.running || gen !== w.gen) return;   // vòng của thế hệ cũ (đã Dừng/Bật lại) → bỏ
  w.busy = true; w.timer = null;
  emitStatus(ex);
  try {
    w.pending.clear();
    // Cùng khoá với recalc() → vòng quét định kỳ và tính lại từ Telegram/web không bao giờ chạy chồng
    const r = await withLock(`cycle:${ex}`, () => runCycle(ex));
    w.lastCycleAt = Date.now();
    if (r.error) w.error = r.error;
    else { w.error = null; w.lastCycleOkAt = w.lastCycleAt; }
  } catch (err) {
    w.error = err.message;
  } finally {
    w.busy = false;
    // Chỉ thế hệ hiện tại mới được lên lịch vòng sau → không bao giờ có 2 chuỗi vòng quét song song
    if (w.running && gen === w.gen) {
      const sec = store.section(ex);
      const interval = Math.max(MIN_INTERVAL[ex], Number(sec.scanInterval) || 30) * 1000;
      // Nếu có yêu cầu tính lại trong lúc đang quét → chạy lại sớm
      w.timer = setTimeout(() => loop(ex, gen), w.pending.size ? 300 : interval);
    }
    emitStatus(ex);
  }
}

function start(ex, { source = 'web' } = {}) {
  const w = workers[ex];
  if (!w) throw new Error(`Sàn không hợp lệ: ${ex}`);
  if (!adapters.get(ex).isConnected()) return { ok: false, msg: 'Chưa kết nối sàn — hãy kết nối trước' };
  if (w.running) return { ok: true, msg: 'Đang chạy' };
  w.running = true; w.error = null;
  const gen = ++w.gen;
  const sec = store.section(ex);
  log(ex, `Auto-pricer bắt đầu — quét mỗi ${Math.max(MIN_INTERVAL[ex], Number(sec.scanInterval) || 30)}s (${source})`, 'success');
  // Nếu vòng cũ còn đang chạy, vòng mới sẽ chờ khoá cycle:${ex} → không chạy chồng
  w.timer = setTimeout(() => loop(ex, gen), 0);
  emitStatus(ex);
  return { ok: true };
}

function stop(ex, { source = 'web', reason } = {}) {
  const w = workers[ex];
  if (!w) throw new Error(`Sàn không hợp lệ: ${ex}`);
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  const was = w.running;
  const inFlight = w.busy;
  w.running = false; w.error = null; w.gen++;
  if (was) log(ex, `Auto-pricer đã dừng${reason ? ' — ' + reason : ''} (${source})${inFlight ? ' — yêu cầu đang gửi dở sẽ hoàn tất, không gửi thêm' : ''}`, 'warn');
  emitStatus(ex);
  return { ok: true, wasRunning: was, inFlight };
}

/**
 * Tính lại giá cho 1 ad ngay sau khi cấu hình đổi (từ Telegram/web).
 *  - Engine đang chạy + ad đang bật → chạy ngay cho ad đó và áp dụng lên sàn
 *  - Ngược lại → chỉ tính giá mục tiêu (không gửi), báo rõ
 */
async function recalc(ex, key) {
  const w = workers[ex];
  const cfg = store.getByKey(ex, key);
  const apply = w.running && cfg?.enabled;
  // Chờ vòng quét đang chạy (nếu có) xong rồi mới tính → không gửi trùng lên sàn
  const r = await withLock(`cycle:${ex}`, () => runCycle(ex, { onlyKeys: new Set([String(key)]), dryRun: !apply, marketMaxAge: 15000 }));
  const res = r.results[key] || r.results[String(key)] || {};
  return {
    applied: !!res.updated, dryRun: !apply, error: r.error, target: res.target ?? null, current: res.current ?? null, best: res.best ?? null,
    status: w.rowStatus[key]?.msg || null,
    note: apply ? null : (!w.running ? 'Auto-pricer của sàn đang dừng — giá mới sẽ áp dụng khi bật' : 'Auto-pricing của ad này đang tắt'),
  };
}

function stopAllForDisconnect(ex) {
  if (workers[ex]?.running) stop(ex, { source: 'system', reason: 'mất kết nối sàn' });
}

// Khi ngắt kết nối 1 sàn → dừng worker của sàn đó (không để engine chạy "mù")
bus.on('connection', ({ key, connected }) => {
  const ex = key === 'mexcPrimary' ? 'mexc' : key;
  if (!connected && workers[ex]) { stopAllForDisconnect(ex); market.setMyAdIds(ex, null); workers[ex].myAdsAt = null; }
  if (workers[ex]) emitStatus(ex);
});

// Đổi chu kỳ quét (web/Telegram) → áp dụng ngay, không chờ hết chu kỳ cũ
bus.on('config', ev => {
  if (ev.scope !== 'settings' || !workers[ev.ex]) return;
  const w = workers[ev.ex];
  if (w.running && !w.busy && w.timer) {
    clearTimeout(w.timer);
    const interval = Math.max(MIN_INTERVAL[ev.ex], Number(store.section(ev.ex).scanInterval) || 30) * 1000;
    const gen = w.gen;
    w.timer = setTimeout(() => loop(ev.ex, gen), Math.min(interval, 1000));
  }
  emitStatus(ev.ex);
});

/**
 * Kiểm tra trước khi Bật auto-pricer cho 1 sàn.
 * errors → không được bật; warnings → vẫn bật nhưng báo cho người dùng.
 */
function validateConfig(ex) {
  const a = adapters.get(ex);
  const errors = [], warnings = [];
  if (!a.isConnected()) errors.push('Chưa kết nối API sàn — kết nối trên dashboard trước');
  const mr = a.marketReady();
  if (a.isConnected() && !mr.ok) errors.push(mr.reason);
  const sec = store.section(ex);
  const adSide = id => getMyAds(ex).find(x => x.id === String(id))?.side;
  const check = (label, cfg, isBuy) => {
    const b = store.boundsOf(cfg, isBuy);
    if (b.floor !== null && b.ceiling !== null && b.floor > b.ceiling) errors.push(`${label}: Sàn (${fmt(b.floor)}) > Trần (${fmt(b.ceiling)})`);
  };
  let enabled = 0;
  if (ex === 'mexc' || ex === 'bingx') {
    for (const [id, c] of Object.entries(ex === 'mexc' ? sec.apConfigs : sec.configs)) {
      if (!c.enabled) continue;
      enabled++;
      check(`#${shortId(id)}`, c, (adSide(id) || 'BUY') === 'BUY');
    }
  } else {
    const seen = new Set();
    for (const r of sec.rows) {
      if (!r.enabled) continue;
      if (!r.advId) { warnings.push(`Dòng #${r.id} đang bật nhưng chưa có Ad ID — sẽ bị bỏ qua`); continue; }
      if (seen.has(String(r.advId))) warnings.push(`Ad ${shortId(r.advId)} có nhiều dòng đang bật — chỉ dòng đầu được dùng`);
      seen.add(String(r.advId));
      enabled++;
      check(`Dòng #${r.id}`, r, r.side === 'buy');
    }
  }
  if (!enabled) warnings.push('Chưa có quảng cáo nào bật Auto Repricing — engine chạy nhưng sẽ không đổi giá');
  return { ok: !errors.length, errors, warnings, enabled };
}

function logsOf(ex, limit = 100) { return workers[ex].logs.slice(0, limit); }
function rowStatusOf(ex) { return workers[ex].rowStatus; }

module.exports = {
  EXCHANGES, start, stop, statusOf, logsOf, rowStatusOf, recalc, runCycle,
  refreshMyAds, getMyAds, clampToBounds, enabledKeys, emitStatus, validateConfig,
  _workers: workers,
};
