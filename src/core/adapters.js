/**
 * Adapter cho từng sàn — chuẩn hoá dữ liệu & thao tác, dùng lại client API đã có.
 *
 * Mỗi adapter cung cấp:
 *   isConnected() / marketReady()
 *   fetchMyAds()                 → { ok, items: [Ad], error }
 *   fetchMarket(side, opts)      → { ok, items: [MarketAd], error }   side = loại ad của merchant: 'BUY' | 'SELL'
 *   buildPayload(...)            → payload cập nhật ad (dùng chung cho engine và thao tác tay)
 *   applyAdChange(ad, cfg, chg)  → gửi thay đổi số lượng / min / max lên sàn, giữ nguyên giá hiện tại
 *   caps                         → khả năng hỗ trợ (bảng tương thích)
 *
 * Ad chuẩn hoá:      { id, side, asset, fiat, price, available, total, min, max, online, statusText, raw }
 * MarketAd chuẩn hoá: { id, name, side, price, available, min, max, payments[], completion, online, lastOnline, raw }
 *
 * Quy ước chiều (giữ đúng như engine cũ):
 *   Ad MUA của tôi  so với ads MUA của merchant khác → giá CAO nhất
 *   Ad BÁN của tôi  so với ads BÁN của merchant khác → giá THẤP nhất
 *   MEXC  : side=BUY / SELL đúng nghĩa ads merchant
 *   Bitget: ads MUA của merchant = side 'sell', ads BÁN = side 'buy'   (theo engine Bitget cũ)
 *   Bybit : ads MUA = side '0', ads BÁN = side '1'
 *   BingX : ads MUA = tradeType 2, ads BÁN = tradeType 1 (tradeType theo góc nhìn người dùng)
 */
const registry = require('./registry');
const config = require('../config');
const { throttle, num, sleep } = require('./util');

const MEXC_COIN_USDT = '128f589271cb4951b03e71e6323eb7be';
const MEXC_PAY = { 1: 'Ngân hàng', 2: 'Momo', 3: 'ZaloPay', 4: 'VNPAY', 5: 'Tiền mặt' };
const mexcPayNames = s => String(s || '').split(',').filter(Boolean).map(m => MEXC_PAY[m.trim()] || `PM-${m.trim()}`);

// Phân loại lỗi để báo rõ ràng (hết hạn key, timeout, mạng...)
function describeError(err) {
  const m = String(err?.message || err || '');
  if (err?.code === 'ECONNABORTED' || /timeout/i.test(m)) return 'Hết thời gian chờ sàn phản hồi (timeout)';
  if (['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err?.code)) return `Lỗi mạng (${err.code})`;
  if (err?.response?.status === 401 || err?.response?.status === 403) return `Sàn từ chối xác thực (HTTP ${err.response.status}) — API key có thể đã hết hạn/bị thu hồi`;
  if (err?.response?.status) return `HTTP ${err.response.status}: ${JSON.stringify(err.response.data || '').slice(0, 150)}`;
  return m.slice(0, 200);
}
function authHint(msg) {
  return /api.?key|signature|sign|expired|invalid key|unauthor|permission|ip/i.test(String(msg || ''))
    ? ' — kiểm tra API key (hết hạn / sai quyền / IP whitelist)' : '';
}

// ══════════════════════════════════════════════════════════
// MEXC
// ══════════════════════════════════════════════════════════
const mexc = {
  id: 'mexc', label: 'MEXC',
  caps: {
    myAds: { ok: true }, market: { ok: true, note: 'Cần kết nối API phụ (Secondary)' },
    editPrice: { ok: true }, editQuantity: { ok: true, note: 'save_or_update: initQuantity' },
    editMinMax: { ok: true }, status: { ok: true, note: 'advStatus OPEN/CLOSE' },
  },
  isConnected: () => !!registry.get('mexcPrimary'),
  marketReady: () => (registry.get('mexcSecondary') ? { ok: true } : { ok: false, reason: 'Chưa kết nối API phụ MEXC (dùng để lấy market)' }),

  normalizeAd(a) {
    const side = String(a.side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const status = String(a.advStatus || '').toUpperCase();
    return {
      id: String(a.advNo || a.davNo || ''), side, asset: a.coinName || 'USDT', fiat: a.fiatUnit || 'VND',
      price: num(a.price), available: num(a.availableQuantity), total: num(a.quantity),
      min: num(a.minSingleTransAmount), max: num(a.maxSingleTransAmount),
      online: status === 'OPEN', statusText: status || '—', raw: a,
    };
  },

  async fetchMyAds() {
    const svc = registry.get('mexcPrimary');
    if (!svc) return { ok: false, items: [], error: 'Chưa kết nối API chính MEXC' };
    try {
      const all = [];
      for (let page = 1; page <= 5; page++) {
        await throttle('mexc');
        const r = await svc.getMyAds({ advStatus: '', coinId: config.defaultCoinId, page, limit: 10 });
        if (r.code !== 0) return page === 1 ? { ok: false, items: [], error: `${r.msg || 'Lỗi'} (code ${r.code})${authHint(r.msg)}` } : { ok: true, items: all.map(mexc.normalizeAd) };
        all.push(...(r.data || []));
        const totalPage = r.page?.totalPage || 1;
        if (page >= totalPage || !(r.data || []).length) break;
      }
      return { ok: true, items: all.map(mexc.normalizeAd) };
    } catch (err) { return { ok: false, items: [], error: describeError(err) }; }
  },

  normalizeMarket(a) {
    return {
      id: String(a.advNo || ''), name: a.merchant?.nickName || '—', side: String(a.side || '').toUpperCase(),
      price: num(a.price), available: num(a.availableQuantity),
      min: num(a.minSingleTransAmount), max: num(a.maxSingleTransAmount),
      payments: mexcPayNames(a.payMethod), completion: num(a.merchantStatistics?.completeRate),
      online: null, lastOnline: a.merchant?.lastOnlineTime || null, raw: a,
    };
  },

  /** Giống engine cũ: tối đa 10 trang, nghỉ ~150ms giữa các trang */
  async fetchMarket(side, { pages = 10, fiat = 'VND' } = {}) {
    const svc = registry.get('mexcSecondary');
    if (!svc) return { ok: false, items: [], error: 'Chưa kết nối API phụ MEXC (dùng để lấy market)' };
    const all = [];
    try {
      for (let page = 1; page <= pages; page++) {
        await throttle('mexc');
        const r = await svc.getMarketAds({ side, fiatUnit: fiat, coinId: MEXC_COIN_USDT, page, blockTrade: true, allowTrade: true, countryCode: 'VN' });
        if (r.code !== 0) {
          if (page === 1) return { ok: false, items: [], error: `${r.msg || 'Lỗi'} (code ${r.code})${authHint(r.msg)}` };
          break;
        }
        const items = Array.isArray(r.data) ? r.data : [];
        if (!items.length) break;
        all.push(...items);
        if (page < pages) await sleep(150);
      }
      return { ok: true, items: all.map(mexc.normalizeMarket) };
    } catch (err) {
      return all.length ? { ok: true, items: all.map(mexc.normalizeMarket), partial: true } : { ok: false, items: [], error: describeError(err) };
    }
  },

  /** Payload save_or_update — y hệt engine MEXC cũ */
  buildPayload(ad, cfg, { price, quantity, min, max, refill } = {}) {
    const raw = ad.raw;
    const isBuy = ad.side === 'BUY';
    const payload = {
      advNo: ad.id, advStatus: 'OPEN', price, side: ad.side, fiatUnit: ad.fiat,
      coinId: raw.coinId || MEXC_COIN_USDT, payTimeLimit: raw.payTimeLimit,
      initQuantity: quantity ?? raw.availableQuantity,
      minSingleTransAmount: min ?? cfg.minTrans ?? raw.minSingleTransAmount,
      maxSingleTransAmount: max ?? cfg.maxTrans ?? raw.maxSingleTransAmount,
      frozenQuantity: raw.frozenQuantity,
      payMethod: isBuy ? 1799581 : (parseFloat(cfg.payMethod) || 1799581),
      countryCode: 'VN', kycLevel: 'PRIMARY',
    };
    if (refill) { payload.initQuantity = refill.avail; payload.supplyQuantity = refill.quantity; }
    // Max không được vượt quá (số lượng − đang khóa) × giá
    const cap = (parseFloat(payload.initQuantity) - (parseFloat(payload.frozenQuantity) || 0)) * parseFloat(payload.price);
    if (Number.isFinite(cap) && parseFloat(payload.maxSingleTransAmount) > cap) payload.maxSingleTransAmount = cap - 1000;
    return payload;
  },

  async sendUpdate(payload) {
    const svc = registry.get('mexcPrimary');
    if (!svc) return { ok: false, msg: 'Chưa kết nối API chính MEXC', exchangeStatus: 'not_connected' };
    try {
      await throttle('mexc');
      const r = await svc.saveOrUpdateAd(payload);
      return r.code === 0
        ? { ok: true, msg: 'OK', exchangeStatus: 'code=0', raw: r }
        : { ok: false, msg: `${r.msg || 'Lỗi'}${authHint(r.msg)}`, exchangeStatus: `code=${r.code}`, raw: r };
    } catch (err) { return { ok: false, msg: describeError(err), exchangeStatus: 'exception' }; }
  },

  async applyAdChange(ad, cfg, chg) {
    const payload = mexc.buildPayload(ad, cfg, { price: ad.price, quantity: chg.quantity, min: chg.min, max: chg.max });
    return mexc.sendUpdate(payload);
  },
};

// ══════════════════════════════════════════════════════════
// BITGET
// ══════════════════════════════════════════════════════════
const BG_API_SIDE = { BUY: 'sell', SELL: 'buy' };   // loại ad merchant → tham số side của Bitget
const bitget = {
  id: 'bitget', label: 'Bitget',
  caps: {
    myAds: { ok: true }, market: { ok: true },
    editPrice: { ok: true }, editQuantity: { ok: true, note: 'ad-update: quantity' },
    editMinMax: { ok: true }, status: { ok: true, note: 'status publish/delist' },
  },
  isConnected: () => !!registry.get('bitget'),
  marketReady: () => (registry.get('bitget') ? { ok: true } : { ok: false, reason: 'Chưa kết nối Bitget' }),

  normalizeAd(a) {
    const side = a.side === 'buy' ? 'BUY' : 'SELL';
    const total = (num(a.soldAmount) || 0) + (num(a.lastAmount) || 0);
    return {
      id: String(a.advId || ''), side, asset: a.token || 'USDT', fiat: a.fiat || 'VND',
      price: num(a.price), available: num(a.lastAmount), total: total || null,
      min: num(a.minAmount), max: num(a.maxAmount),
      online: a.status === 'publish', statusText: a.status || '—', raw: a,
    };
  },

  async fetchMyAds() {
    const svc = registry.get('bitget');
    if (!svc) return { ok: false, items: [], error: 'Chưa kết nối Bitget' };
    try {
      await throttle('bitget');
      const r = await svc.getAllAds();
      if (r.code !== '00000') return { ok: false, items: [], error: `${r.msg || 'Lỗi'} (code ${r.code})${authHint(r.msg)}` };
      return { ok: true, items: (r.data?.items || []).map(bitget.normalizeAd) };
    } catch (err) { return { ok: false, items: [], error: describeError(err) }; }
  },

  async fetchAdInfo(advId) {
    const svc = registry.get('bitget');
    if (!svc) return { ok: false, error: 'Chưa kết nối Bitget' };
    try {
      await throttle('bitget');
      const r = await svc.getAdInfo(advId);
      if (r.code !== '00000' || !r.data) return { ok: false, error: r.msg || 'Không tìm thấy ad (có thể đã bị xóa)' };
      return { ok: true, ad: bitget.normalizeAd(r.data) };
    } catch (err) { return { ok: false, error: describeError(err) }; }
  },

  normalizeMarket(a) {
    return {
      id: String(a.advId || ''), name: a.merchantName || '—', side: a.side === 'sell' ? 'BUY' : 'SELL',
      price: num(a.price), available: num(a.quantity), min: num(a.minAmount), max: num(a.maxAmount),
      payments: (a.payMethods || []).map(p => p.payMethodName || `PM-${p.payMethodId}`),
      completion: num(a.completedRate), online: null, lastOnline: null, raw: a,
    };
  },

  /** amount: lọc phía sàn (như engine cũ, 1 trang × 10). Không có amount: lấy 3 trang. */
  async fetchMarket(side, { amount = '', pages } = {}) {
    const svc = registry.get('bitget');
    if (!svc) return { ok: false, items: [], error: 'Chưa kết nối Bitget' };
    const nPages = pages || (amount ? 1 : 3);
    const all = [];
    try {
      for (let p = 1; p <= nPages; p++) {
        await throttle('bitget');
        const params = { token: 'USDT', fiat: 'VND', side: BG_API_SIDE[side], pageNum: String(p), limit: '10' };
        if (amount) params.amount = String(amount);
        const r = await svc.getAdList(params);
        if (r.code !== '00000') {
          if (p === 1) return { ok: false, items: [], error: `${r.msg || 'Lỗi'} (code ${r.code})${authHint(r.msg)}` };
          break;
        }
        const items = r.data?.items || [];
        all.push(...items);
        if (items.length < 10) break;
      }
      return { ok: true, items: all.map(bitget.normalizeMarket) };
    } catch (err) { return { ok: false, items: [], error: describeError(err) }; }
  },

  extractPayMethods(raw) {
    const list = raw.payMethodIds || raw.payMethods || [];
    if (!Array.isArray(list)) return [];
    return list.map(p => {
      if (p == null) return null;
      if (typeof p !== 'object') return { payMethodId: String(p) };
      const pmId = p.payMethodId ?? p.payId ?? p.id;
      if (pmId == null) return null;
      const item = { payMethodId: String(pmId) };
      const userPm = p.userPayMethodId ?? p.userPayId ?? p.userPaymentId;
      if (userPm != null) item.userPayMethodId = String(userPm);
      return item;
    }).filter(Boolean);
  },

  /** Payload ad-update — y hệt engine Bitget cũ */
  buildPayload(ad, row, { price, quantity, min, max }) {
    const isBuy = ad.side === 'BUY';
    let maxAmount = max ?? num(row.maxAmount);
    const capByQty = quantity * price;
    if (maxAmount === null || maxAmount === undefined || maxAmount > capByQty) maxAmount = capByQty;
    const payload = {
      advId: ad.id, priceType: 'fixed', price: String(price),
      payTimeLimit: isBuy ? '30' : '10',
      payMethodIds: bitget.extractPayMethods(ad.raw),
      quantity: String(quantity), maxAmount: String(Math.floor(maxAmount)),
    };
    const minAmount = min ?? row.minAmount;
    if (minAmount !== '' && minAmount != null) payload.minAmount = String(minAmount);
    return payload;
  },

  async sendUpdate(payload) {
    const svc = registry.get('bitget');
    if (!svc) return { ok: false, msg: 'Chưa kết nối Bitget', exchangeStatus: 'not_connected' };
    if (!payload.payMethodIds?.length) return { ok: false, msg: 'Thiếu payMethodIds từ ad-info — không thể cập nhật', exchangeStatus: 'local_validation' };
    try {
      await throttle('bitget');
      const r = await svc.updateAd(payload);
      return r.code === '00000'
        ? { ok: true, msg: 'OK', exchangeStatus: 'code=00000', raw: r }
        : { ok: false, msg: `${r.msg || 'Lỗi'}${authHint(r.msg)}`, exchangeStatus: `code=${r.code}`, raw: r };
    } catch (err) { return { ok: false, msg: describeError(err), exchangeStatus: 'exception' }; }
  },

  async applyAdChange(ad, row, chg) {
    const info = await bitget.fetchAdInfo(ad.id);     // luôn đọc lại ad để có payMethodIds + số lượng mới nhất
    if (!info.ok) return { ok: false, msg: info.error, exchangeStatus: 'ad_info_failed' };
    const fresh = info.ad;
    const quantity = chg.quantity ?? (num(row.quantity) ?? fresh.available ?? 0);
    const payload = bitget.buildPayload(fresh, row, { price: Math.round(fresh.price), quantity, min: chg.min, max: chg.max });
    return bitget.sendUpdate(payload);
  },
};

// ══════════════════════════════════════════════════════════
// BYBIT
// ══════════════════════════════════════════════════════════
const BY_API_SIDE = { BUY: '0', SELL: '1' };
const BY_PAYMENT_IDS = ['23871618', '23871387'];   // cố định như engine Bybit cũ
const bybit = {
  id: 'bybit', label: 'Bybit',
  caps: {
    myAds: { ok: true }, market: { ok: true },
    editPrice: { ok: true }, editQuantity: { ok: true, note: 'item/update: quantity' },
    editMinMax: { ok: true }, status: { ok: true, note: 'status 10 = đang đăng; isOnline' },
  },
  isConnected: () => registry.bybit.isConnected(),
  marketReady: () => (registry.bybit.isConnected() ? { ok: true } : { ok: false, reason: 'Chưa kết nối Bybit' }),

  normalizeAd(a) {
    return {
      id: String(a.id ?? ''), side: Number(a.side) === 0 ? 'BUY' : 'SELL', asset: a.tokenId || 'USDT', fiat: a.currencyId || 'VND',
      price: num(a.price), available: num(a.lastQuantity ?? a.quantity), total: num(a.quantity),
      min: num(a.minAmount), max: num(a.maxAmount),
      online: Number(a.status) === 10, statusText: Number(a.status) === 10 ? 'Đang đăng' : `Ẩn (${a.status})`, raw: a,
    };
  },

  async fetchMyAds() {
    if (!registry.bybit.isConnected()) return { ok: false, items: [], error: 'Chưa kết nối Bybit' };
    try {
      await throttle('bybit');
      const r = await registry.bybit.getMyAds({});
      if (r.ret_code !== 0) return { ok: false, items: [], error: `${r.ret_msg || 'Lỗi'} (code ${r.ret_code})${authHint(r.ret_msg)}` };
      const res = r.result || {};
      const list = Array.isArray(res.items) ? res.items : Array.isArray(res.list) ? res.list : Array.isArray(res) ? res : [];
      return { ok: true, items: list.map(bybit.normalizeAd) };
    } catch (err) { return { ok: false, items: [], error: describeError(err) }; }
  },

  normalizeMarket(a) {
    const rate = num(a.recentExecuteRate);
    return {
      id: String(a.id ?? ''), name: a.nickName || '—', side: Number(a.side) === 0 ? 'BUY' : 'SELL',
      price: num(a.price), available: num(a.lastQuantity ?? a.quantity), min: num(a.minAmount), max: num(a.maxAmount),
      payments: (a.payments || []).map(p => `PM-${p}`), completion: rate === null ? null : rate / 100,
      online: a.isOnline === true, lastOnline: null, raw: a,
    };
  },

  async fetchMarket(side, { token = 'USDT', fiat = 'VND', size = '50' } = {}) {
    if (!registry.bybit.isConnected()) return { ok: false, items: [], error: 'Chưa kết nối Bybit' };
    try {
      await throttle('bybit');
      const r = await registry.bybit.getOnlineAds({ tokenId: token, currencyId: fiat, side: BY_API_SIDE[side], size });
      if (r.ret_code !== 0) return { ok: false, items: [], error: `${r.ret_msg || 'Lỗi'} (code ${r.ret_code})${authHint(r.ret_msg)}` };
      return { ok: true, items: (r.result?.items || []).map(bybit.normalizeMarket) };
    } catch (err) { return { ok: false, items: [], error: describeError(err) }; }
  },

  /** Payload item/update — y hệt engine Bybit cũ */
  buildPayload(ad, { price, quantity, min, max }) {
    const raw = ad.raw;
    return {
      id: ad.id, priceType: String(raw.priceType ?? 0), premium: String(raw.premium ?? ''),
      price: String(price), minAmount: String(min), maxAmount: String(max),
      remark: raw.remark ?? '', tradingPreferenceSet: {}, paymentIds: BY_PAYMENT_IDS,
      actionType: 'MODIFY', quantity: String(quantity), paymentPeriod: String(raw.paymentPeriod ?? 15),
    };
  },

  async sendUpdate(payload) {
    if (!registry.bybit.isConnected()) return { ok: false, msg: 'Chưa kết nối Bybit', exchangeStatus: 'not_connected' };
    try {
      await throttle('bybit');
      const r = await registry.bybit.updateAd(payload);
      return r.ret_code === 0
        ? { ok: true, msg: 'OK', exchangeStatus: 'ret_code=0', raw: r }
        : { ok: false, msg: `${r.ret_msg || 'Lỗi'}${authHint(r.ret_msg)}`, exchangeStatus: `ret_code=${r.ret_code}`, raw: r };
    } catch (err) { return { ok: false, msg: describeError(err), exchangeStatus: 'exception' }; }
  },

  async applyAdChange(ad, row, chg) {
    const avail = Math.max(0, (num(ad.raw.lastQuantity) || 0) - (num(ad.raw.frozenQuantity) || 0));
    const min = chg.min ?? (num(row.minAmount) ?? ad.min);
    const max = chg.max ?? (num(row.maxAmount) ?? ad.max);
    if (min == null || max == null) return { ok: false, msg: 'Thiếu Min/Max', exchangeStatus: 'local_validation' };
    const scale = ad.raw.symbolInfo?.currency?.scale ?? 2;
    const payload = bybit.buildPayload(ad, { price: (+ad.price).toFixed(scale), quantity: chg.quantity ?? avail, min, max });
    return bybit.sendUpdate(payload);
  },
};

// ══════════════════════════════════════════════════════════
// BINGX
// ══════════════════════════════════════════════════════════
const BX_TRADE_TYPE = { BUY: 2, SELL: 1 };
const bingx = {
  id: 'bingx', label: 'BingX',
  caps: {
    myAds: { ok: true }, market: { ok: true, note: 'Không cần ký' },
    editPrice: { ok: true }, editQuantity: { ok: true, note: 'advert/modify: totalNumber (TỔNG số lượng, không phải khả dụng)' },
    editMinMax: { ok: true }, status: { ok: true, note: 'status 0 Listed / 1 Delisted' },
  },
  isConnected: () => registry.bingx.isConnected(),
  marketReady: () => ({ ok: true }),

  normalizeAd(a) {
    return {
      id: String(a.advertNo), side: Number(a.tradeType) === 1 ? 'BUY' : 'SELL', asset: a.asset || 'USDT', fiat: a.fiatUnit || 'VND',
      price: Number(a.priceType) === 2 ? null : num(a.fixedPrice), available: num(a.availableAmount ?? a.totalNumber), total: num(a.totalNumber),
      min: num(a.minAmount), max: num(a.maxAmount),
      online: Number(a.status) === 0, statusText: Number(a.status) === 0 ? 'Listed' : 'Delisted',
      floating: Number(a.priceType) === 2, raw: a,
    };
  },

  async fetchMyAds() {
    if (!registry.bingx.isConnected()) return { ok: false, items: [], error: 'Chưa kết nối BingX' };
    try {
      await throttle('bingx');
      const r = await registry.bingx.getMyAdsAll();
      if (r.code !== 0) return { ok: false, items: [], error: `${r.msg || 'Lỗi'} (code ${r.code})${authHint(r.msg)}` };
      return { ok: true, items: (r.data?.result || []).map(bingx.normalizeAd) };
    } catch (err) { return { ok: false, items: [], error: describeError(err) }; }
  },

  normalizeMarket(a, side) {
    const rate = num(a.completionRate ?? a.recentOrderCompletionRate ?? a.recent30DaysCompletionRate);
    return {
      id: String(a.advertNo), name: a.nickname || '—', side,
      price: num(a.price), available: num(a.availableAmount), min: num(a.minPerOrderAmount), max: num(a.maxPerOrderAmount),
      payments: (a.paymentMethods || []).map(p => p.name || `PM-${p.id}`),
      completion: rate === null ? null : (rate > 1 ? rate / 100 : rate),
      trades30d: num(a.recent30DaysTradeNum), online: null, lastOnline: null, raw: a,
    };
  },

  async fetchMarket(side, { pages = 3, asset = 'USDT', fiat = 'VND' } = {}) {
    try {
      await throttle('bingx');
      const r = await registry.bingx.getMarketAdsAll({ asset, fiatUnit: fiat, tradeType: BX_TRADE_TYPE[side], pages });
      if (r.code !== 0) return { ok: false, items: [], error: `${r.msg || 'Lỗi'} (code ${r.code})` };
      return { ok: true, items: (r.data?.result || []).map(a => bingx.normalizeMarket(a, side)) };
    } catch (err) { return { ok: false, items: [], error: describeError(err) }; }
  },

  async sendUpdate({ advertNo, price, minAmount, maxAmount, totalNumber }) {
    if (!registry.bingx.isConnected()) return { ok: false, msg: 'Chưa kết nối BingX', exchangeStatus: 'not_connected' };
    try {
      await throttle('bingx');
      const r = await registry.bingx.updateAdPrice({ advertNo, price, minAmount, maxAmount, totalNumber });
      return r.code === 0
        ? { ok: true, msg: 'OK', exchangeStatus: 'code=0', raw: r }
        : { ok: false, msg: `${r.msg || 'Lỗi'}${authHint(r.msg)}`, exchangeStatus: `code=${r.code}`, raw: r };
    } catch (err) { return { ok: false, msg: describeError(err), exchangeStatus: 'exception' }; }
  },

  async applyAdChange(ad, cfg, chg) {
    if (ad.floating) return { ok: false, msg: 'Ad đang dùng giá thả nổi — sửa sẽ chuyển sang giá cố định, hãy đổi trên web/sàn', exchangeStatus: 'unsupported' };
    return bingx.sendUpdate({
      advertNo: ad.id, price: String(ad.price),
      minAmount: chg.min != null ? String(chg.min) : undefined,
      maxAmount: chg.max != null ? String(chg.max) : undefined,
      totalNumber: chg.quantity != null ? String(chg.quantity) : undefined,
    });
  },
};

const adapters = { mexc, bitget, bybit, bingx };
const EXCHANGES = Object.keys(adapters);

function get(ex) {
  const a = adapters[ex];
  if (!a) throw new Error(`Sàn không hợp lệ: ${ex}`);
  return a;
}

module.exports = { get, EXCHANGES, adapters, describeError };
