// server/services/p2p.service.js
const axios = require('axios');
const SignatureService = require('./signature.service');
const API_CONFIG = require('../config/api.config');

class P2PService {
  constructor(apiKey, secretKey, gateway = 'mexc.com') {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.baseUrl = API_CONFIG.endpoints[gateway] || API_CONFIG.endpoints['mexc.com'];
  }

  /**
   * Get common headers for authenticated requests
   */
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-MEXC-APIKEY': this.apiKey
    };
  }

  /**
   * Fetch paginated market ads (Buy or Sell)
   * @param {Object} options
   * @param {string} options.side - 'BUY' | 'SELL'
   * @param {string} options.fiatUnit - e.g., 'VND'
   * @param {string} options.coinId - e.g., 'USDT'
   * @param {number} options.page
   * @param {number} options.amount
   * @param {number} options.quantity
   * @param {string} options.countryCode
   * @param {string} options.payMethod
   */
  async getMarketAds(options = {}) {
    const {
      side,
      fiatUnit = API_CONFIG.defaults.fiatUnit,
      coinId = 'USDT',
      page = API_CONFIG.defaults.page,
      amount,
      quantity,
      countryCode,
      payMethod
    } = options;

    const params = {
      fiatUnit,
      coinId,
      page
    };

    if (side) params.side = side;
    if (amount) params.amount = amount;
    if (quantity) params.quantity = quantity;
    if (countryCode) params.countryCode = countryCode;
    if (payMethod) params.payMethod = payMethod;

    const { queryString, signature, timestamp } = SignatureService.generateSignature(params, this.secretKey);
    
    const url = `${this.baseUrl}${API_CONFIG.p2p.marketAds}?${queryString}&signature=${signature}`;

    try {
      const response = await axios.get(url, {
        headers: this.getHeaders(),
        timeout: 10000
      });

      if (response.data.code !== 0) {
        throw new Error(`MEXC API Error: ${response.data.msg || 'Unknown error'} (code: ${response.data.code})`);
      }

      return response.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Get both BUY and SELL ads simultaneously
   */
  async getBothSidesAds(options = {}) {
    const [buyAds, sellAds] = await Promise.allSettled([
      this.getMarketAds({ ...options, side: 'BUY' }),
      this.getMarketAds({ ...options, side: 'SELL' })
    ]);

    return {
      buy: buyAds.status === 'fulfilled' ? buyAds.value : { error: buyAds.reason.message },
      sell: sellAds.status === 'fulfilled' ? sellAds.value : { error: sellAds.reason.message }
    };
  }
}

module.exports = P2PService;
