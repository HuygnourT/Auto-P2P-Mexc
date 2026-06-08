const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Service kết nối Bitget P2P API — UTA (Unified Trading Account).
 *
 * Authentication: HMAC-SHA256 + Base64
 *   preHash = timestamp + METHOD + requestPath + queryString + body
 *   Sign = Base64( HMAC-SHA256( secretKey, preHash ) )
 *
 * Endpoints:
 *   GET  /api/v3/p2p/my-ads     — lấy ads của tôi (UTA V3)
 *   POST /api/v2/p2p/advUpdate  — cập nhật ad (chờ V3 docs)
 *
 * V3 Get My Ads — tất cả params optional:
 *   startTime, endTime, limit, cursor, advId, token, fiat,
 *   status (publish/delist/remove)
 *
 * V3 Response:
 *   data.items[]: { advId, side, priceType, token, fiat, price,
 *     soldAmount, lastAmount, payMethods, status, createdTime, updatedTime }
 *   data.nextId: cursor phân trang
 */

class BitgetP2PService {
  constructor(apiKey, secretKey, passphrase) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.passphrase = passphrase;
    this.baseUrl = 'https://api.bitget.com';
  }

  sign(timestamp, method, requestPath, queryString, body) {
    queryString = queryString ? '?' + queryString : '';
    body = body || '';
    const preHash = timestamp + method.toUpperCase() + requestPath + queryString + body;
    logger.debug(`[Bitget] preHash: ${preHash}`);
    const hmac = crypto.createHmac('sha256', this.secretKey);
    return hmac.update(preHash).digest('base64');
  }

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

  buildQueryString(params) {
    return Object.entries(params)
      .filter(([_, v]) => v !== undefined && v !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
  }

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
   * GET /api/v3/p2p/my-ads — lấy ads của tôi (UTA).
   * Tất cả params optional.
   */
  async getMyAds(params = {}) {
    return this.getRequest('/api/v3/p2p/my-ads', params);
  }

  /**
   * GET /api/v3/p2p/ad-info — lấy thông tin chi tiết 1 ad.
   * Required: advId
   */
  async getAdInfo(advId) {
    return this.getRequest('/api/v3/p2p/ad-info', { advId });
  }

  /**
   * GET /api/v3/p2p/ad-list — lấy giá quảng cáo trên thị trường.
   * Required: token, fiat, side, pageNum, limit
   * Optional: amount
   */
  async getAdList(params = {}) {
    return this.getRequest('/api/v3/p2p/ad-list', params);
  }

/**
 * POST /api/v3/p2p/ad-update — cập nhật ad (UTA V3).
 * Required: advId, payTimeLimit
 * Optional: priceType, price, premium, minAmount, maxAmount,
 *           quantity, payMethodIds[], remark, tradeTerms
 */
async updateAd(bodyObj) {
  return this.postRequest('/api/v3/p2p/ad-update', bodyObj);
}

  /**
   * Test kết nối + lấy ads đang publish.
   */
  async testConnection() {
    try {
      logger.info('[Bitget] Testing connection (UTA V3)...');
      const result = await this.getMyAds({ limit: '10', token : 'USDT', fiat : 'VND', advId : '1420836731317575681' });
      logger.info(`[Bitget] testConnection response code: ${result.code}`);
      console.log(JSON.stringify(result));

      if (result.code === '00000') {
        const items = result.data?.items || [];
        logger.info(`[Bitget] Connected — found ${items.length} publish ads`);
        items.forEach(ad => {
          logger.info(`[Bitget]   ${ad.advId} | ${ad.side} | ${ad.token}/${ad.fiat} | price=${ad.price} | last=${ad.lastAmount} | sold=${ad.soldAmount} | status=${ad.status}`);
        });
        return true;
      } else {
        logger.error(`[Bitget] Failed: code=${result.code}, msg=${result.msg}`);
        return false;
      }
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
   * Lấy ads đang publish (online).
   */
  async getOnlineAds() {
    return this.getMyAds({ status: 'publish', limit: '10' });
  }

  /**
   * Lấy tất cả ads.
   */
  async getAllAds() {
    return this.getMyAds({ limit: '10' });
  }
}

module.exports = BitgetP2PService;
