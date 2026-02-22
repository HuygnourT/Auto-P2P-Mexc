// server/services/p2p.service.js
const axios = require('axios');
const API_CONFIG = require('../config/api.config');

class P2PService {
  constructor(gateway = 'mexc.com') {
    this.baseUrl = API_CONFIG.endpoints[gateway] || API_CONFIG.endpoints['mexc.com'];
  }

  /**
   * Fetch paginated market ads (Buy or Sell)
   * Public endpoint - no authentication required
   * @param {Object} options
   * @param {string} options.side       - 'BUY' | 'SELL'
   * @param {string} options.fiatUnit   - e.g. 'VND'
   * @param {string} options.coinId     - e.g. 'USDT'
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

    const params = new URLSearchParams({ fiatUnit, coinId, page });

    if (side)        params.set('side', side);
    if (amount)      params.set('amount', amount);
    if (quantity)    params.set('quantity', quantity);
    if (countryCode) params.set('countryCode', countryCode);
    if (payMethod)   params.set('payMethod', payMethod);

    const url = `${this.baseUrl}${API_CONFIG.p2p.marketAds}?${params.toString()}`;

    try {
      const response = await axios.get(url, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      if (response.data.code !== 0) {
        throw new Error(
          `MEXC API Error: ${response.data.msg || 'Unknown error'} (code: ${response.data.code})`
        );
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
      buy:  buyAds.status  === 'fulfilled' ? buyAds.value  : { error: buyAds.reason.message },
      sell: sellAds.status === 'fulfilled' ? sellAds.value : { error: sellAds.reason.message }
    };
  }
}

module.exports = P2PService;
