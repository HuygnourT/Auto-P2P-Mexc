const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Service kết nối Bitget P2P API V2.
 *
 * Authentication: HMAC-SHA256 + Base64 (theo tài liệu chính thức Bitget + Java SDK mẫu)
 *   Headers: ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE
 *
 *   preHash = timestamp + METHOD + requestPath + queryString + body
 *     - queryString rỗng → ""
 *     - queryString có giá trị → "?" + params (sort alphabet by key)
 *     - body rỗng (GET) → ""
 *   Sign = Base64( HMAC-SHA256( secretKey, preHash ) )
 *
 * Endpoints V2:
 *   GET  /api/v2/p2p/advList    — lấy danh sách ads của merchant
 *   POST /api/v2/p2p/advUpdate  — cập nhật giá/thông tin ad
 *
 * Required params cho advList:
 *   startTime (String) — Unix millisecond timestamp
 *   status    (String) — online / offline / editing / completed
 *   side      (String) — buy / sell
 *   coin      (String) — VD: USDT
 *   fiat      (String) — VD: VND
 */

class BitgetP2PService {
  constructor(apiKey, secretKey, passphrase) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.passphrase = passphrase;
    this.baseUrl = 'https://api.bitget.com';
  }

  /**
   * Tạo chữ ký HMAC-SHA256 Base64.
   * Match chính xác với Java SDK mẫu:
   *   queryString = isBlank ? "" : "?" + queryString
   *   body = isBlank ? "" : body
   *   preHash = timestamp + method + requestPath + queryString + body
   */
  sign(timestamp, method, requestPath, queryString, body) {
    queryString = queryString ? '?' + queryString : '';
    body = body || '';
    const preHash = timestamp + method.toUpperCase() + requestPath + queryString + body;
    logger.debug(`[Bitget] preHash: ${preHash}`);
    const hmac = crypto.createHmac('sha256', this.secretKey);
    return hmac.update(preHash).digest('base64');
  }

  /**
   * Tạo headers cho request.
   */
  getHeaders(method, requestPath, queryString, body) {
    const timestamp = Date.now().toString();
    const signature = this.sign(timestamp, method, requestPath, queryString || '', body || '');
    return {
      'ACCESS-KEY': this.apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json',
      'locale': 'en-US',
    };
  }

  /**
   * Build queryString từ params object.
   * - Lọc bỏ undefined / rỗng
   * - Sort alphabet theo key (yêu cầu của Bitget)
   * - Không dùng encodeURIComponent
   */
  buildQueryString(params) {
    return Object.entries(params)
      .filter(([_, v]) => v !== undefined && v !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
  }

  /**
   * GET request chung — xử lý error response chi tiết.
   */
  async getRequest(requestPath, params = {}) {
    const queryString = this.buildQueryString(params);
    const headers = this.getHeaders('GET', requestPath, queryString, '');
    const url = queryString
      ? `${this.baseUrl}${requestPath}?${queryString}`
      : `${this.baseUrl}${requestPath}`;

    logger.debug(`[Bitget] GET ${url}`);

    try {
      const res = await axios.get(url, { headers, timeout: 15000 });
      return res.data;
    } catch (err) {
      if (err.response) {
        logger.error(`[Bitget] GET ${requestPath} → ${err.response.status}`, JSON.stringify(err.response.data));
        return err.response.data;
      }
      throw err;
    }
  }

  /**
   * POST request chung — xử lý error response chi tiết.
   */
  async postRequest(requestPath, bodyObj = {}) {
    const body = JSON.stringify(bodyObj);
    const headers = this.getHeaders('POST', requestPath, '', body);

    logger.debug(`[Bitget] POST ${requestPath} body=${body}`);

    try {
      const res = await axios.post(`${this.baseUrl}${requestPath}`, body, { headers, timeout: 15000 });
      return res.data;
    } catch (err) {
      if (err.response) {
        logger.error(`[Bitget] POST ${requestPath} → ${err.response.status}`, JSON.stringify(err.response.data));
        return err.response.data;
      }
      throw err;
    }
  }

  /**
   * GET /api/v2/p2p/advList — lấy danh sách ads của merchant.
   *
   * Required params:
   *   startTime (String) — Unix ms timestamp
   *   status    (String) — online / offline / editing / completed
   *   side      (String) — buy / sell
   *   coin      (String) — VD: USDT
   *   fiat      (String) — VD: VND
   *
   * Optional params:
   *   endTime      (String) — Unix ms timestamp, max 90 ngày từ startTime
   *   idLessThan   (String) — minAdvId từ query trước (phân trang)
   *   limit        (String) — số lượng, default 20, max 20
   *   language     (String) — zh-CN / en-US
   *   advNo        (String) — mã quảng cáo cụ thể
   *   orderBy      (String) — createTime / price (default: createTime desc)
   *   payMethodId  (String) — ID phương thức thanh toán
   *   sourceType   (String) — owner / competition / ownerAndCompetition
   */
  async getAdvList(params = {}) {
    return this.getRequest('/api/v2/p2p/advList', params);
  }

  /**
   * POST /api/v2/p2p/advUpdate — cập nhật ad.
   *
   * Body fields:
   *   advNo          — mã quảng cáo (bắt buộc)
   *   price          — giá mới (string)
   *   coin           — loại coin, VD: "USDT"
   *   fiatCode       — mã fiat, VD: "VND"
   *   type           — "buy" hoặc "sell"
   *   amount         — số lượng
   *   minAmount      — giới hạn tối thiểu
   *   maxAmount      — giới hạn tối đa
   *   status         — "online" / "offline"
   *   payDuration    — thời gian thanh toán (phút)
   *   paymentMethod  — mảng phương thức thanh toán
   *   remark         — ghi chú
   */
  async updateAd(bodyObj) {
    return this.postRequest('/api/v2/p2p/advUpdate', bodyObj);
  }

  /**
   * Test kết nối + lấy tất cả ads USDT/VND đang online (cả BUY + SELL).
   * Phải gọi 2 lần vì side là param bắt buộc.
   */
  async testConnection() {
    try {
      logger.info('[Bitget] Testing connection...');
      const now = Date.now().toString();
      const baseParams = { startTime: now, status: 'online', coin: 'USDT', fiat: 'VND', limit: '20' };

      const buyResult = await this.getAdvList({ ...baseParams, side: 'buy' });
      const sellResult = await this.getAdvList({ ...baseParams, side: 'sell' });

      const buyOk = buyResult.code === '00000';
      const sellOk = sellResult.code === '00000';

      if (!buyOk && !sellOk) {
        logger.error(`[Bitget] Connection failed — BUY: code=${buyResult.code} msg=${buyResult.msg} | SELL: code=${sellResult.code} msg=${sellResult.msg}`);
        return false;
      }

      const buyAds = buyOk ? (buyResult.data?.advList || []) : [];
      const sellAds = sellOk ? (sellResult.data?.advList || []) : [];
      const allAds = [...buyAds, ...sellAds];

      logger.info(`[Bitget] Connected — ${buyAds.length} BUY + ${sellAds.length} SELL online ads`);
      allAds.forEach(ad => {
        logger.info(`[Bitget]   ${ad.advNo} | ${ad.type} | ${ad.coin}/${ad.fiatCode} | price=${ad.price} | amount=${ad.amount} | status=${ad.status}`);
      });

      return true;
    } catch (err) {
      if (err.response) {
        logger.error(`[Bitget] HTTP ${err.response.status}:`, JSON.stringify(err.response.data));
      } else {
        logger.error('[Bitget] Error:', err.message);
      }
      return false;
    }
  }

  /**
   * Lấy tất cả ads USDT/VND đang online (BUY + SELL).
   * Trả về format thống nhất: { code, data: { advList: [...] } }
   */
  async getOnlineAds() {
    const now = Date.now().toString();
    const baseParams = { startTime: now, status: 'online', coin: 'USDT', fiat: 'VND', limit: '20' };

    const buyResult = await this.getAdvList({ ...baseParams, side: 'buy' });
    const sellResult = await this.getAdvList({ ...baseParams, side: 'sell' });

    const buyAds = buyResult.code === '00000' ? (buyResult.data?.advList || []) : [];
    const sellAds = sellResult.code === '00000' ? (sellResult.data?.advList || []) : [];

    return { code: '00000', data: { advList: [...buyAds, ...sellAds] } };
  }

  /**
   * Lấy tất cả ads USDT/VND (cả online + offline).
   */
  async getAllAds() {
    const now = Date.now().toString();
    const base = { startTime: now, coin: 'USDT', fiat: 'VND', limit: '20' };
    const results = [];

    for (const status of ['online', 'offline']) {
      for (const side of ['buy', 'sell']) {
        const r = await this.getAdvList({ ...base, status, side });
        if (r.code === '00000' && r.data?.advList) {
          results.push(...r.data.advList);
        }
      }
    }

    return { code: '00000', data: { advList: results } };
  }
}

module.exports = BitgetP2PService;
