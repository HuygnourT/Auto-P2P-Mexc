const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Service kết nối BingX P2P OpenAPI.
 *
 * Domain: https://open-api.bingx.com
 * Xác thực (theo https://bingx-api.github.io/docs/#/swapV2/authentication.html#Signature):
 *   - Header  X-BX-APIKEY: <apiKey>
 *   - Ghép tất cả params + timestamp thành "k=v&k=v" (giá trị RAW, KHÔNG encode)
 *   - signature = hex( HMAC-SHA256(secretKey, chuỗi trên) )
 *   - Gửi lên: query string với giá trị đã URL-encode + "&signature=..."
 *
 * Endpoint dùng:
 *   3.1  GET  /openApi/p2p/v1/advert/list           — ads trên market (PHẢI ký: thiếu chữ ký → code 100412 "Null signature")
 *   3.8  POST /openApi/p2p/v1/merchant/advert/modify — sửa ad đầy đủ (giá + SL + Min/Max…)
 *   3.19 POST /openApi/p2p/v1/merchant/advert/modifyPrice — CHỈ đổi giá {advertNo, priceType, fixedPrice}
 *   3.10 GET  /openApi/p2p/v1/merchant/myAdvert      — ads của tôi (Listed + Delisted)
 *
 * Lưu ý: advertNo là số 19 chữ số (> Number.MAX_SAFE_INTEGER) → phải parse JSON
 * dạng chuỗi, nếu không ID bị sai và sửa nhầm/không sửa được ad.
 */

// Tài liệu ghi 2 đường dẫn khác nhau giữa bản EN/CN → thử lần lượt, nhớ đường dẫn chạy được
const PATHS = {
  market: ['/openApi/p2p/v1/advert/list', '/openApi/p2p/v1/ads/list'],
  // Đường dẫn phân biệt hoa/thường: phải là "p2p" chữ thường ("P2P" chữ hoa gây lỗi)
  myAds: ['/openApi/p2p/v1/merchant/myAdvert'],
  modify: ['/openApi/p2p/v1/merchant/advert/modify'],
  modifyPrice: ['/openApi/p2p/v1/merchant/advert/modifyPrice'],
};

// Bọc số nguyên ≥ 16 chữ số thành chuỗi trước khi JSON.parse (giữ đúng advertNo)
function safeJsonParse(text) {
  const fixed = String(text).replace(/(:\s*)(-?\d{16,})(\s*[,}\]])/g, '$1"$2"$3');
  return JSON.parse(fixed);
}

class BingxP2P {
  constructor() {
    // Domain chính + domain dự phòng (theo tài liệu BingX: chỉ đổi sang .pro khi lỗi mạng/timeout)
    this.baseUrls = process.env.BINGX_BASE_URL
      ? [process.env.BINGX_BASE_URL]
      : ['https://open-api.bingx.com', 'https://open-api.bingx.pro'];
    this.baseUrl = this.baseUrls[0];
    this.apiKey = null;
    this.secretKey = null;
    // Kiểu gửi POST: 'auto' (thử query, lỗi tham số/chữ ký thì thử JSON body) | 'query' | 'json'
    this.postMode = 'auto';
    this.postModeWorking = null;   // chế độ đã chạy thành công (khi 'auto')
    this.timeOffset = 0;           // chênh lệch giờ server BingX − giờ máy (ms)
    this.connected = false;
    this.workingPath = {};     // nhớ đường dẫn chạy được cho mỗi loại endpoint
    this.myAdsCache = new Map();
  }

  connect({ apiKey, secretKey, postMode }) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.postMode = ['query', 'json', 'form'].includes(postMode) ? postMode : 'auto';
    this.postModeWorking = null;
    this.connected = true;
  }

  disconnect() {
    this.apiKey = null;
    this.secretKey = null;
    this.connected = false;
    this.myAdsCache.clear();
  }

  isConnected() { return this.connected; }

  /**
   * Chuẩn hoá params theo tài liệu "Signature Authentication" của BingX:
   *  1. Lấy tất cả business params (không gồm signature), bỏ giá trị rỗng
   *  2. Thêm timestamp (ms) như 1 param thường (+ recvWindow, mặc định 5000)
   *  3. Sắp xếp key theo ASCII tăng dần
   * Trả về giá trị đã chuẩn hoá (giữ kiểu số cho JSON body) + danh sách key đã sắp xếp.
   */
  _prepare(params = {}) {
    const p = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      // tham số cấu trúc (mảng/object) → chuỗi JSON
      p[k] = (typeof v === 'object') ? JSON.stringify(v) : v;
    }
    if (p.recvWindow === undefined) p.recvWindow = 5000;
    p.timestamp = Date.now() + this.timeOffset;
    const keys = Object.keys(p).sort();
    return { p, keys };
  }

  _sign(str) {
    return crypto.createHmac('sha256', this.secretKey).update(str).digest('hex');
  }

  /**
   * Dựng request theo đúng kiểu truyền params (mục "Signature Description"):
   *
   *  query — Ký trên chuỗi CHƯA encode "k=v&k=v". Trên URL: nếu chuỗi ký có "[" hoặc "{"
   *          thì URL-encode giá trị (UTF-8, khoảng trắng = %20, không encode key);
   *          nếu không có thì gửi nguyên giá trị (chỉ thay ký tự không hợp lệ trong URL
   *          như khoảng trắng/tiếng Việt). Gắn &signature=... ở cuối.
   *  form  — application/x-www-form-urlencoded: encode từng giá trị UTF-8, ghép chuỗi ĐÃ encode,
   *          ký TRỰC TIẾP trên chuỗi đã encode đó, body = chuỗi đó + &signature=...
   *  json  — application/json: timestamp + signature nằm TRONG body, không đặt trên URL.
   *          Chuỗi ký = "k=v&k=v" (chưa encode) theo key đã sắp xếp.
   */
  _build(method, path, params, signed, mode) {
    const { p, keys } = this._prepare(params);
    const rawStr = keys.map(k => `${k}=${p[k]}`).join('&');
    const enc = v => encodeURIComponent(String(v));                 // UTF-8, khoảng trắng → %20
    // chỉ thay các ký tự không hợp lệ trên URL (khoảng trắng, &, #, %, ký tự ngoài ASCII...)
    const urlSafe = v => String(v).replace(/[^A-Za-z0-9\-_.~!*'():,;=@$+\/?]/gu, c => encodeURIComponent(c));

    if (method === 'POST' && mode === 'form') {
      const encodedStr = keys.map(k => `${k}=${enc(p[k])}`).join('&');
      const signature = signed ? this._sign(encodedStr) : null;
      return {
        pathAndQuery: path,
        data: encodedStr + (signature ? `&signature=${signature}` : ''),
        contentType: 'application/x-www-form-urlencoded',
        signingString: encodedStr,
      };
    }

    const signature = signed ? this._sign(rawStr) : null;

    if (method === 'POST' && mode === 'json') {
      const body = {};
      for (const k of keys) body[k] = p[k];
      if (signature) body.signature = signature;
      return { pathAndQuery: path, data: body, contentType: 'application/json', signingString: rawStr };
    }

    const needEncode = /[\[{]/.test(rawStr);
    const qs = keys.map(k => `${k}=${needEncode ? enc(p[k]) : urlSafe(p[k])}`).join('&');
    return {
      pathAndQuery: `${path}?${qs}${signature ? `&signature=${signature}` : ''}`,
      data: undefined,
      contentType: null,
      signingString: rawStr,
    };
  }

  async _send(method, path, params, signed, mode = 'query') {
    if (signed && !this.secretKey) throw new Error('BingX chưa kết nối');
    const req = this._build(method, path, params, signed, mode);
    const headers = {};
    if (this.apiKey) headers['X-BX-APIKEY'] = this.apiKey;
    if (req.contentType) headers['Content-Type'] = req.contentType;

    logger.debug(`[BingX] ${method} ${path} (${mode}) sign="${req.signingString}"`);
    const res = await this._http({ method, pathAndQuery: req.pathAndQuery, data: req.data, headers });

    let body;
    try {
      body = safeJsonParse(res.data);
    } catch (e) {
      const snippet = String(res.data || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
      const err = new Error(`BingX HTTP ${res.status} — phản hồi không phải JSON: ${snippet}`);
      err.httpStatus = res.status;
      throw err;
    }
    if (typeof body !== 'object' || body === null) body = { code: -1, msg: String(res.data).slice(0, 200) };
    body.__httpStatus = res.status;
    if (body.code !== 0 && !(res.status === 200 && body.code === undefined && !body.msg)) {
      logger.error(`[BingX] ${method} ${path} HTTP ${res.status} code=${body.code} msg=${body.msg}`);
    }
    return body;
  }

  // Gửi HTTP; chỉ chuyển sang domain dự phòng khi lỗi mạng/timeout (không phải lỗi API)
  async _http({ method, pathAndQuery, data, headers }) {
    const order = [this.baseUrl, ...this.baseUrls.filter(u => u !== this.baseUrl)];
    let lastErr;
    for (const base of order) {
      try {
        const sentAt = Date.now();
        const res = await axios({
          method, url: base + pathAndQuery, data, headers,
          timeout: 10000,
          transformResponse: r => r,          // lấy text thô để parse an toàn số lớn
          validateStatus: () => true,
        });
        if (base !== this.baseUrl) {
          logger.warn(`[BingX] Chuyển sang domain dự phòng ${base}`);
          this.baseUrl = base;
        }
        this._syncTime(res.data, sentAt);
        return res;
      } catch (err) {
        lastErr = err;
        const network = !err.response && ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND',
          'EAI_AGAIN', 'ECONNREFUSED', 'ERR_NETWORK'].includes(err.code);
        if (!network) throw err;
        logger.warn(`[BingX] Lỗi mạng với ${base}: ${err.code}`);
      }
    }
    throw lastErr;
  }

  // Server từ chối nếu serverTime − timestamp > recvWindow → đo lệch giờ từ field "timestamp" của response
  _syncTime(text, sentAt) {
    const m = /"(?:timestamp|serverTime)"\s*:\s*"?(\d{13})/.exec(String(text || ''));
    if (!m) return;
    const now = Date.now();
    const offset = Number(m[1]) - Math.round((sentAt + now) / 2);
    if (Math.abs(offset) > 1000) {
      if (Math.abs(offset - this.timeOffset) > 1000) logger.warn(`[BingX] Giờ máy lệch ${offset}ms so với server — tự bù`);
      this.timeOffset = offset;
    } else {
      this.timeOffset = 0;
    }
  }

  // Thử lần lượt các đường dẫn của 1 endpoint (khi gặp 404), nhớ đường dẫn chạy được
  async _call(kind, method, params, signed, mode = 'query') {
    const list = this.workingPath[kind] ? [this.workingPath[kind]] : PATHS[kind];
    let lastErr = null;
    for (const path of list) {
      try {
        const before = this.timeOffset;
        let body = await this._send(method, path, params, signed, mode);
        // Bị từ chối vì timestamp (giờ máy lệch) → giờ đã được bù từ response, gửi lại 1 lần
        if (body.code !== 0 && this.timeOffset !== before && /timestamp|recvWindow|time/i.test(String(body.msg || ''))) {
          logger.warn(`[BingX] Gửi lại sau khi bù lệch giờ ${this.timeOffset}ms`);
          body = await this._send(method, path, params, signed, mode);
        }
        if (body.__httpStatus === 404) { lastErr = Object.assign(new Error(`404 ${path}`), { httpStatus: 404 }); continue; }
        this.workingPath[kind] = path;
        const status = body.__httpStatus;
        delete body.__httpStatus;
        Object.defineProperty(body, '__httpStatus', { value: status, enumerable: false });   // giữ để xét lỗi 5xx, không lộ ra JSON
        return body;
      } catch (err) {
        lastErr = err;
        if (err.httpStatus !== 404) throw err;
      }
    }
    throw lastErr || new Error(`BingX: không gọi được ${kind}`);
  }

  /**
   * 3.1 Ads trên market.
   * @param tradeType 1 = người dùng MUA (thấy ads BÁN của merchant), 2 = người dùng BÁN (thấy ads MUA)
   */
  async getMarketAds({ asset = 'USDT', fiatUnit = 'VND', tradeType, pageId = 0, pageSize = 100 }) {
    // BingX yêu cầu chữ ký cho cả API market (gửi không ký → 100412 Null signature)
    if (!this.secretKey) throw new Error('BingX chưa kết nối (market cần API key để ký)');
    return this._call('market', 'GET', { asset, fiatUnit, tradeType, pageId, pageSize }, true);
  }

  /** Lấy nhiều trang market, gộp lại */
  async getMarketAdsAll({ asset, fiatUnit, tradeType, pages = 3, pageSize = 100 }) {
    const all = [];
    for (let pageId = 0; pageId < pages; pageId++) {
      const r = await this.getMarketAds({ asset, fiatUnit, tradeType, pageId, pageSize });
      if (r.code !== 0) {
        if (pageId === 0) return r;   // lỗi ngay trang đầu → trả lỗi
        break;
      }
      const items = r.data?.result || [];
      all.push(...items);
      const total = Number(r.data?.total) || 0;
      if (items.length < pageSize || (total && all.length >= total)) break;
    }
    return { code: 0, data: { result: all, total: all.length } };
  }

  /** 3.10 Toàn bộ ads của tôi (Listed + Delisted), tự phân trang */
  async getMyAdsAll(pageSize = 100, maxPages = 10) {
    const all = [];
    for (let pageId = 0; pageId < maxPages; pageId++) {
      const r = await this._call('myAds', 'GET', { pageId, pageSize }, true);
      if (r.code !== 0) {
        if (pageId === 0) return r;
        break;
      }
      const items = r.data?.result || [];
      all.push(...items);
      const total = Number(r.data?.total) || 0;
      if (items.length < pageSize || (total && all.length >= total)) break;
    }
    this.myAdsCache = new Map(all.map(a => [String(a.advertNo), a]));
    return { code: 0, data: { result: all, total: all.length } };
  }

  async getMyAd(advertNo, refresh = false) {
    if (refresh || !this.myAdsCache.has(String(advertNo))) await this.getMyAdsAll();
    return this.myAdsCache.get(String(advertNo)) || null;
  }

  /**
   * Gửi POST có ký. Chế độ 'auto': thử query → json → form, nhớ kiểu chạy được.
   * Chỉ thử kiểu tiếp theo khi lỗi giống lỗi định dạng/tham số/chữ ký HOẶC lỗi nội bộ của sàn
   * ("internal server error" thường do sàn không đọc được params theo kiểu gửi đó).
   * Gửi lại an toàn vì cùng một nội dung sửa (đặt giá = giá trị cố định).
   */
  async _postSigned(kind, params) {
    if (this.postMode !== 'auto') return this._call(kind, 'POST', params, true, this.postMode);
    if (this.postModeWorking) {
      const r = await this._call(kind, 'POST', params, true, this.postModeWorking);
      if (r.code === 0 || !isRetryable(r)) return r;
      logger.warn(`[BingX] ${kind} lỗi với kiểu ${this.postModeWorking} đã nhớ (${r.code} ${r.msg}) → thử lại các kiểu khác`);
      this.postModeWorking = null;
    }
    let first = null;
    for (const mode of ['query', 'json', 'form']) {
      const r = await this._call(kind, 'POST', params, true, mode);
      if (r.code === 0) {
        this.postModeWorking = mode;
        logger.info(`[BingX] Kiểu gửi POST dùng được: ${mode}`);
        return r;
      }
      if (!first) first = { ...r, mode };
      if (!isRetryable(r)) return { ...r, mode };
      logger.warn(`[BingX] ${kind} lỗi với kiểu ${mode} (${r.code} ${r.msg})`);
    }
    return first;
  }

  /** 3.8 Sửa ad — params đầy đủ theo tài liệu */
  async modifyAd(params) { return this._postSigned('modify', params); }

  /** 3.19 Chỉ đổi giá — ít tham số, không đụng SL / Min / Max / điều khoản / phương thức thanh toán */
  async modifyAdPrice({ advertNo, price }) {
    return this._postSigned('modifyPrice', { advertNo: String(advertNo), priceType: 1, fixedPrice: trimNum(price) });
  }

  /**
   * Đổi giá 1 ad.
   *  - Chỉ đổi giá (auto repricing) → LUÔN dùng 3.19 modifyPrice, chỉ gửi {advertNo, priceType: 1, fixedPrice}.
   *    Không bao giờ chuyển sang 3.8 (3.8 gửi lại cả điều kiện khớp lệnh/thanh toán/điều khoản).
   *  - Đổi SL / Min / Max (thao tác thủ công) → 3.8 với đầy đủ field hiện tại của ad (3.10).
   */
  async updateAdPrice({ advertNo, price, minAmount, maxAmount, totalNumber }) {
    const ad = await this.getMyAd(advertNo);
    if (!ad) return { code: -1, msg: `Không tìm thấy ad ${advertNo} trong danh sách ads của tôi` };

    const priceOnly = !minAmount && !maxAmount && !totalNumber;
    let r = null, payload, endpoint;
    if (priceOnly) {
      payload = { advertNo: String(ad.advertNo), priceType: 1, fixedPrice: trimNum(price) };
      endpoint = '3.19 modifyPrice';
      try {
        r = await this.modifyAdPrice({ advertNo: ad.advertNo, price });
      } catch (err) {
        r = { code: -1, msg: err.httpStatus === 404 ? 'Sàn trả 404 cho /openApi/p2p/v1/merchant/advert/modifyPrice' : err.message };
      }
    } else {
      payload = buildModifyPayload(ad, { price, minAmount, maxAmount, totalNumber });
      endpoint = '3.8 advert/modify';
      r = await this.modifyAd(payload);
    }
    if (r.code === 0) {
      // cập nhật cache để lần so sánh sau đúng
      ad.fixedPrice = String(price);
      if (payload.minAmount) ad.minAmount = payload.minAmount;
      if (payload.maxAmount) ad.maxAmount = payload.maxAmount;
      if (payload.totalNumber) ad.totalNumber = payload.totalNumber;
    } else {
      logger.error(`[BingX] Sửa ad ${ad.advertNo} lỗi qua ${endpoint}${r.mode ? ` (kiểu ${r.mode})` : ''}: code=${r.code} ${r.msg}`);
    }
    return { ...r, endpoint, sent: payload };
  }
}

// Lỗi đáng thử kiểu gửi khác: định dạng/tham số/chữ ký hoặc lỗi nội bộ của sàn (5xx / "internal server error")
function isRetryable(r) {
  const m = String(r?.msg || '');
  return /param|signature|sign|null|empty|required|missing|json|format|illegal|invalid|content.?type|media|internal|server error|system error|customer support/i.test(m)
    || (r?.__httpStatus >= 500);
}

// Bỏ số 0 thừa: "6668.000000000000000" → "6668"
function trimNum(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function buildModifyPayload(ad, { price, minAmount, maxAmount, totalNumber } = {}) {
  const userPaymentMethods = (ad.paymentMethods || [])
    .map(p => p.userPaymentMethodId ?? p.id)
    .filter(v => v !== undefined && v !== null)
    .map(Number);

  // Chỉ gửi điều kiện CÓ giá trị: điều kiện trống (chưa bật) gửi lên sẽ bị sàn báo
  // "registryDays is not a digit; isBindPhone is not a boolean..."
  const userMatchConditions = (ad.userMatchConditions || [])
    .filter(c => c && c.conditionName && c.conditionValue !== undefined && c.conditionValue !== null && c.conditionValue !== '')
    .map(c => ({ conditionName: c.conditionName, conditionValue: String(c.conditionValue) }));

  const payload = {
    advertNo: String(ad.advertNo),
    priceType: 1,                                       // FIXED
    fixedPrice: trimNum(price),
    totalNumber: trimNum(totalNumber || ad.totalNumber),
    minAmount: trimNum(minAmount || ad.minAmount),
    maxAmount: trimNum(maxAmount || ad.maxAmount),
    paymentTimeLimit: ad.paymentTimeLimit,
    userMatchConditions: JSON.stringify(userMatchConditions),
    userPaymentMethods: JSON.stringify(userPaymentMethods),
    termDesc: ad.termsDesc ?? ad.termDesc ?? '',          // 3.8 nhận "termDesc" (3.10 trả về "termsDesc")
    autoReplyMsg: ad.autoReplyMsg ?? '',
    hidePaymentInfo: ad.hidePaymentInfo,
  };
  return payload;
}

// Gợi ý nguyên nhân từ thông báo lỗi của BingX
function explain(r) {
  const m = String(r?.msg || '').toLowerCase();
  if (/signature/.test(m)) return 'Chữ ký sai → kiểm tra lại Secret Key (copy thiếu/thừa ký tự, khoảng trắng)';
  if (/ip/.test(m) && /white|allow|bind/.test(m)) return 'IP máy chạy app chưa nằm trong IP whitelist của API key';
  if (/api.?key|apikey|key.*(not exist|invalid|incorrect)/.test(m)) return 'API Key sai hoặc đã bị xóa';
  if (/permission|authori|forbidden|access/.test(m)) return 'API key thiếu quyền (cần quyền Đọc + P2P transactions, tạo trên tài khoản P2P merchant)';
  if (/timestamp|recvwindow|time/.test(m)) return 'Giờ máy lệch so với server BingX';
  if (/merchant|advert/.test(m)) return 'Tài khoản chưa là P2P merchant hoặc chưa được mở P2P OpenAPI';
  return '';
}

/**
 * Kiểm tra kết nối từng bước với key nhập trên form (không ảnh hưởng kết nối đang chạy).
 */
async function diagnose({ apiKey, secretKey }) {
  const t = new BingxP2P();
  t.apiKey = apiKey; t.secretKey = secretKey; t.connected = true;
  const steps = [];
  const add = (step, ok, detail, hint = '') => steps.push({ step, ok, detail, hint });
  const fmt = r => `${r.__httpStatus ? `HTTP ${r.__httpStatus} · ` : ''}code=${r.code} · ${r.msg || (r.code === 0 ? 'OK' : '')}`;

  // 1. Mạng + giờ server (public)
  try {
    const r = await t._send('GET', '/openApi/swap/v2/server/time', {}, false);
    add('1. Kết nối tới BingX + giờ server', r.code === 0, `${t.baseUrl} · ${fmt(r)} · lệch giờ máy ${t.timeOffset}ms`,
      Math.abs(t.timeOffset) > 5000 ? 'Giờ máy lệch > 5s — app đã tự bù, nhưng nên đồng bộ giờ Windows' : '');
  } catch (err) {
    add('1. Kết nối tới BingX + giờ server', false, err.message, 'Máy chạy app không truy cập được open-api.bingx.com (mạng/firewall/VPN)');
    return steps;
  }

  // 2. Market P2P (có ký bằng API key)
  try {
    const r = await t.getMarketAds({ tradeType: 1, pageId: 0, pageSize: 5 });
    add(`2. Market P2P (3.1) ${t.workingPath.market || ''}`, r.code === 0,
      `${fmt(r)}${r.code === 0 ? ` · ${(r.data?.result || []).length} ads` : ''}`, r.code === 0 ? '' : explain(r));
  } catch (err) { add('2. Market P2P (3.1)', false, err.message); }

  // 3. Kiểm tra API key + chữ ký bằng 1 endpoint ký chung
  for (const path of ['/openApi/v1/account/apiPermissions', '/openApi/spot/v1/account/balance']) {
    try {
      const r = await t._send('GET', path, {}, true);
      if (r.__httpStatus === 404) continue;
      // apiPermissions trả dữ liệu TRỰC TIẾP (không bọc {code,msg,data}) → HTTP 200, không có code/msg lỗi = thành công
      const { __httpStatus, ...payload } = r;
      const bare = __httpStatus === 200 && r.code === undefined && !r.msg && Object.keys(payload).length > 0;
      const ok = r.code === 0 || bare;
      const sigOk = ok || !/signature|api.?key|apikey/i.test(String(r.msg || ''));
      let detail = bare ? `HTTP 200 · OK` : fmt(r);
      if (ok && path.includes('apiPermissions')) {
        const d = r.code === 0 ? r.data : payload;
        detail += ` · ${JSON.stringify(d).slice(0, 300)}`;
      }
      add(`3. API Key + chữ ký (${path})`, ok, detail,
        ok ? '' : (sigOk ? 'Chữ ký hợp lệ nhưng bị từ chối: ' + (explain(r) || 'xem msg') : explain(r)));
      break;
    } catch (err) { add(`3. API Key + chữ ký (${path})`, false, err.message); break; }
  }

  // 4. Ads của tôi (3.10) — thử cả 2 đường dẫn trong tài liệu
  for (const path of PATHS.myAds) {
    try {
      const r = await t._send('GET', path, { pageId: 0, pageSize: 10 }, true);
      add(`4. Ads của tôi (3.10) ${path}`, r.code === 0,
        `${fmt(r)}${r.code === 0 ? ` · ${(r.data?.result || []).length} ads` : ''}`,
        r.code === 0 ? '' : (r.__httpStatus === 404 ? 'Đường dẫn không tồn tại' : explain(r)));
      if (r.code === 0 || r.__httpStatus !== 404) break;   // chỉ thử đường dẫn khác khi 404
    } catch (err) {
      add(`4. Ads của tôi (3.10) ${path}`, false, err.message, err.httpStatus === 404 ? 'Đường dẫn không tồn tại' : '');
      if (err.httpStatus !== 404) break;
    }
  }
  return steps;
}

module.exports = new BingxP2P();
module.exports.diagnose = diagnose;
module.exports.explain = explain;
module.exports.buildModifyPayload = buildModifyPayload;
module.exports.safeJsonParse = safeJsonParse;
