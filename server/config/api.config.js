// server/config/api.config.js
const API_CONFIG = {
  endpoints: {
    'mexc.com': 'https://api.mexc.com',
    'mexc.co': 'https://api.mexc.co'
  },
  p2p: {
    marketAds: '/api/v3/fiat/market/ads/pagination'
  },
  defaults: {
    fiatUnit: 'VND',
    page: 1,
    limit: 20
  },
  rateLimit: {
    maxRequests: 10,
    perSeconds: 1
  }
};

module.exports = API_CONFIG;
