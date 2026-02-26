const axios = require('axios');
const { buildSignedQuery } = require('../utils/crypto');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Service chính giao tiếp với MEXC P2P API.
 * Mỗi instance giữ thông tin API Key, Secret Key và host.
 * Cung cấp các phương thức gọi API: lấy ads market, lấy ads cá nhân, tạo/cập nhật ads.
 */
class MexcP2PService {
  /**
   * Khởi tạo service với thông tin xác thực.
   * Tạo axios client với base URL, timeout, và header X-MEXC-APIKEY.
   * @param {string} apiKey - API Key từ tài khoản MEXC
   * @param {string} secretKey - Secret Key từ tài khoản MEXC
   * @param {string} apiHost - Host API (api.mexc.com hoặc api.mexc.co)
   */
  constructor(apiKey, secretKey, apiHost = 'api.mexc.com') {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.baseUrl = `https://${apiHost}`;
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'X-MEXC-APIKEY': this.apiKey,
      },
    });

    // Interceptor ghi log mỗi request gửi đi
    this.client.interceptors.request.use((config) => {
      logger.debug(`[API] ${config.method.toUpperCase()} ${config.url}`);
      return config;
    });

    // Interceptor bắt lỗi response và ghi log
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        logger.error(`[API Error] ${error.message}`, error.response?.data);
        throw error;
      }
    );
  }

  /**
   * Lấy danh sách quảng cáo trên market (tất cả merchant).
   * Gọi API: GET /api/v3/fiat/market/ads/pagination
   * Dùng để hiển thị bảng BUY/SELL ads trên giao diện chính.
   * @param {Object} options - Bộ lọc: fiatUnit, side (BUY/SELL), coinId, page, amount, payMethod
   * @returns {Promise<Object>} Kết quả phân trang gồm data[] và page{}
   */
  async getMarketAds(options = {}) {
    const params = {
      fiatUnit: options.fiatUnit || 'VND',
      side: options.side,                      // BUY hoặc SELL
      coinId: options.coinId || config.defaultCoinId,
      countryCode: options.countryCode || '',
      payMethod: options.payMethod || '',
      amount: options.amount || '',
      quantity: options.quantity || '',
      page: options.page || 1,
      // blockTrade: options.blockTrade || false,
      // allowTrade: options.allowTrade !== undefined ? options.allowTrade : '',
      // haveTrade: options.haveTrade !== undefined ? options.haveTrade : '',
      follow: options.follow !== undefined ? options.follow : '',
    };

    // Loại bỏ các tham số rỗng trước khi gửi request
    const cleanParams = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== '' && value !== undefined) {
        cleanParams[key] = value;
      }
    }

    // Tạo query string đã ký và gọi API
    const signedQuery = buildSignedQuery(cleanParams, this.secretKey);
    const response = await this.client.get(`/api/v3/fiat/market/ads/pagination?${signedQuery}`);
    return response.data;
  }

  /**
   * Lấy danh sách quảng cáo của merchant (bản thân mình).
   * Gọi API: GET /api/v3/fiat/merchant/ads/pagination
   * Dùng để quản lý ads cá nhân đã đăng.
   * @param {Object} options - Bộ lọc: coinId, advStatus (OPEN/CLOSE), page, limit
   * @returns {Promise<Object>} Kết quả phân trang gồm data[] và page{}
   */
  async getMyAds(options = {}) {
    const params = {
      coinId: options.coinId || config.defaultCoinId,
      advStatus: options.advStatus || '',
      page: options.page || 1,
      limit: options.limit || 10,
    };

    const cleanParams = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== '' && value !== undefined) {
        cleanParams[key] = value;
      }
    }

    const signedQuery = buildSignedQuery(cleanParams, this.secretKey);
    const response = await this.client.get(`/api/v3/fiat/merchant/ads/pagination?${signedQuery}`);
    return response.data;
  }

  /**
   * Tạo mới hoặc cập nhật quảng cáo P2P.
   * Gọi API: POST /api/v3/fiat/merchant/ads/save_or_update
   * Nếu body có advNo thì sẽ cập nhật, không có thì tạo mới.
   * @param {Object} adData - Dữ liệu quảng cáo (price, coinId, side, payMethod, ...)
   * @returns {Promise<Object>} Response chứa advNo (mã quảng cáo)
   */
  async saveOrUpdateAd(adData) {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const { generateSignature } = require('../utils/crypto');
    const signature = generateSignature(queryString, this.secretKey);

    const response = await this.client.post(
      `/api/v3/fiat/merchant/ads/save_or_update?timestamp=${timestamp}&signature=${signature}`,
      adData
    );
    return response.data;
  }

  /**
   * Kiểm tra kết nối API có hoạt động không.
   * Thử gọi API lấy market ads với fiatUnit=VND.
   * Nếu response trả code=0 tức là kết nối thành công.
   * @returns {Promise<boolean>} true nếu kết nối OK, false nếu lỗi
   */
  async testConnection() {
    try {
      const params = { fiatUnit: 'VND', page: 1, coinId: config.defaultCoinId };
      const signedQuery = buildSignedQuery(params, this.secretKey);
      const response = await this.client.get(`/api/v3/fiat/market/ads/pagination?${signedQuery}`);
      return response.data.code === 0;
    } catch (error) {
      logger.error('Connection test failed:', error.message);
      return false;
    }
  }
}

module.exports = MexcP2PService;
