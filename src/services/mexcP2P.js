const axios = require('axios');
const { buildSignedQuery, generateSignature } = require('../utils/crypto');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Service chính giao tiếp với MEXC P2P API.
 * Mỗi instance giữ thông tin API Key, Secret Key và host.
 * Cung cấp các phương thức gọi API: lấy ads market, lấy ads cá nhân, tạo/cập nhật ads.
 */
class MexcP2PService {
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

    this.client.interceptors.request.use((config) => {
      logger.debug(`[API] ${config.method.toUpperCase()} ${config.url}`);
      return config;
    });

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
   */
  async getMarketAds(options = {}) {
    const params = {
      fiatUnit: options.fiatUnit || 'VND',
      side: options.side,
      coinId: options.coinId || config.defaultCoinId,
      countryCode: options.countryCode || 'VN',
      payMethod: options.payMethod || '',
      amount: options.amount || '',
      quantity: options.quantity || '',
      page: options.page || 1,
      blockTrade: options.blockTrade !== undefined ? options.blockTrade : true,
      allowTrade: options.allowTrade !== undefined ? options.allowTrade : true,
      follow: options.follow !== undefined ? options.follow : '',
    };

    const cleanParams = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== '' && value !== undefined) {
        cleanParams[key] = value;
      }
    }

    const signedQuery = buildSignedQuery(cleanParams, this.secretKey);
    const response = await this.client.get(`/api/v3/fiat/market/ads/pagination?${signedQuery}`);
    return response.data;
  }

  /**
   * Lấy danh sách quảng cáo của merchant (bản thân mình).
   * Gọi API: GET /api/v3/fiat/merchant/ads/pagination
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
   *
   * Theo tài liệu MEXC API:
   *   - Request method: POST
   *   - Params gửi qua POST body (JSON)
   *   - timestamp + signature gửi qua query string (chuẩn MEXC auth)
   *
   * Cách ký (signature):
   *   1. Ghép toàn bộ body params + timestamp thành chuỗi "key=value&key=value"
   *   2. Ký chuỗi đó bằng HMAC-SHA256
   *   3. Gắn timestamp + signature lên URL query string
   *
   * @param {Object} options - Dữ liệu quảng cáo theo tài liệu API
   * @returns {Promise<Object>} Response chứa advNo
   */
  async saveOrUpdateAd(options = {}) {
    // ── Build body từ tất cả field theo tài liệu API ──
    const bodyParams = {
      // Required khi update
      advNo: options.advNo,                               // String  — Mã QC (bắt buộc khi update)
      // Required fields
      payTimeLimit: options.payTimeLimit,                  // Integer — Thời gian thanh toán (phút)
      initQuantity: options.initQuantity,                  // BigDecimal — Số lượng ban đầu
      price: options.price,                                // BigDecimal — Giá mỗi đơn vị fiat
      coinId: options.coinId,                              // String  — ID coin (USDT, BTC, ...)
      side: options.side,                                  // String  — BUY hoặc SELL
      fiatUnit: options.fiatUnit,                          // String  — Đơn vị fiat (VND, USD, ...)
      payMethod: options.payMethod,                        // String  — ID phương thức thanh toán
      minSingleTransAmount: options.minSingleTransAmount,  // BigDecimal — Giới hạn giao dịch tối thiểu
      maxSingleTransAmount: options.maxSingleTransAmount,  // BigDecimal — Giới hạn giao dịch tối đa
      // Optional fields
      supplyQuantity: options.supplyQuantity,              // BigDecimal — Số lượng bổ sung
      countryCode: options.countryCode,                    // String  — Mã quốc gia
      advStatus: options.advStatus,                        // String  — OPEN / CLOSE
      allowSys: options.allowSys,                          // Boolean — Cho phép hệ thống tự trả lời
      autoReplyMsg: "Xin%20Chao%20Anh%28Ch%E1%BB%8B%29%0A%0AEm%20%C4%91ang%20online.%20%20Ch%C3%BAc%20Anh%28Ch%E1%BB%8B%29%20trade%20xxx%20t%C3%A0i%20kho%E1%BA%A3n.%20%0A%0AEm%20x%E1%BB%AD%20l%C3%AD%20l%E1%BB%87nh%20tu%E1%BA%A7n%20t%E1%BB%B1%20l%E1%BB%87nh%20n%C3%A0o%20%C6%B0u%20ti%C3%AAn%20tr%C6%B0%E1%BB%9Bc%20s%E1%BA%BD%20thanh%20to%C3%A1n%20tr%C6%B0%E1%BB%9Bc.%20Anh%20%28%20Ch%E1%BB%8B%20%29%20th%E1%BA%A5y%20b%C3%AAn%20em%20x%E1%BB%AD%20l%C3%AD%20nhanh%20g%E1%BB%8Dn%20c%C3%B3%20th%E1%BB%83%20%C4%91%C3%A1nh%20gi%C3%A1%20t%C3%ADch%20c%E1%BB%B1c%20gi%C3%BAp.%20Em%20c%E1%BA%A3m%20%C6%A1n",                  // String  — Tin nhắn tự động
      tradeTerms: options.tradeTerms,                      // String  — Điều khoản giao dịch
      kycLevel: options.kycLevel,                          // String  — Mức KYC yêu cầu
      requireMobile: options.requireMobile,                // Boolean — Yêu cầu xác minh SĐT
      userAllTradeCountMin: options.userAllTradeCountMin,  // Integer — Số giao dịch fiat tối thiểu
      userAllTradeCountMax: options.userAllTradeCountMax,  // Integer — Số giao dịch fiat tối đa
      exchangeCount: options.exchangeCount,                // Integer — Khối lượng giao dịch spot
      maxPayLimit: options.maxPayLimit,                    // Integer — Số lệnh tối đa cùng 1 user
      buyerRegDaysLimit: options.buyerRegDaysLimit,        // Integer — Số ngày đăng ký tối thiểu
      creditAmount: options.creditAmount,                  // BigDecimal — Hạn mức tín dụng
      blockTrade: options.blockTrade,                      // Boolean — Hạn chế giao dịch nhất định
      deviceId: options.deviceId,                          // String  — ID thiết bị
    };

    // Loại bỏ các field rỗng/undefined/null
    const cleanBody = {};
    for (const [key, value] of Object.entries(bodyParams)) {
      if (value !== '' && value !== undefined && value !== null) {
        cleanBody[key] = value;
      }
    }

    const signedQuery = buildSignedQuery(cleanBody, this.secretKey);
    const response = await this.client.post(`/api/v3/fiat/merchant/ads/save_or_update?${signedQuery}`);
    
    return response.data;
  }

  /**
   * Kiểm tra kết nối API có hoạt động không.
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
