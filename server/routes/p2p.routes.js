// server/routes/p2p.routes.js
const express = require('express');
const router = express.Router();
const P2PService = require('../services/p2p.service');
const API_CONFIG = require('../config/api.config');

/**
 * Validate API credentials middleware
 */
function requireCredentials(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.body?.apiKey;
  const secretKey = req.headers['x-secret-key'] || req.body?.secretKey;

  if (!apiKey || !secretKey) {
    return res.status(401).json({
      success: false,
      error: 'API Key and Secret Key are required. Pass via headers: x-api-key, x-secret-key'
    });
  }

  req.apiKey = apiKey;
  req.secretKey = secretKey;
  next();
}

/**
 * GET /api/p2p/ads
 * Get market ads with filters
 * Query: side, fiatUnit, coinId, page, amount, quantity, countryCode, payMethod, gateway
 */
router.get('/ads', requireCredentials, async (req, res) => {
  try {
    const {
      side,
      fiatUnit = API_CONFIG.defaults.fiatUnit,
      coinId = 'USDT',
      page = 1,
      amount,
      quantity,
      countryCode,
      payMethod,
      gateway = 'mexc.com'
    } = req.query;

    // Validate gateway
    if (!API_CONFIG.endpoints[gateway]) {
      return res.status(400).json({
        success: false,
        error: `Invalid gateway. Choose from: ${Object.keys(API_CONFIG.endpoints).join(', ')}`
      });
    }

    const p2pService = new P2PService(req.apiKey, req.secretKey, gateway);

    let result;
    if (!side) {
      // Fetch both sides
      result = await p2pService.getBothSidesAds({ fiatUnit, coinId, page, amount, quantity, countryCode, payMethod });
    } else {
      const sideUpper = side.toUpperCase();
      if (!['BUY', 'SELL'].includes(sideUpper)) {
        return res.status(400).json({ success: false, error: 'side must be BUY or SELL' });
      }
      result = await p2pService.getMarketAds({ side: sideUpper, fiatUnit, coinId, page, amount, quantity, countryCode, payMethod });
    }

    res.json({ success: true, data: result, gateway, filters: { fiatUnit, coinId, side, page, amount, quantity } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/p2p/ads/buy
 * Get BUY side ads only
 */
router.get('/ads/buy', requireCredentials, async (req, res) => {
  try {
    const { fiatUnit = 'VND', coinId = 'USDT', page = 1, amount, quantity, gateway = 'mexc.com' } = req.query;
    const p2pService = new P2PService(req.apiKey, req.secretKey, gateway);
    const result = await p2pService.getMarketAds({ side: 'BUY', fiatUnit, coinId, page, amount, quantity });
    res.json({ success: true, data: result, side: 'BUY' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/p2p/ads/sell
 * Get SELL side ads only
 */
router.get('/ads/sell', requireCredentials, async (req, res) => {
  try {
    const { fiatUnit = 'VND', coinId = 'USDT', page = 1, amount, quantity, gateway = 'mexc.com' } = req.query;
    const p2pService = new P2PService(req.apiKey, req.secretKey, gateway);
    const result = await p2pService.getMarketAds({ side: 'SELL', fiatUnit, coinId, page, amount, quantity });
    res.json({ success: true, data: result, side: 'SELL' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/p2p/gateways
 * List available gateways
 */
router.get('/gateways', (req, res) => {
  res.json({
    success: true,
    gateways: Object.keys(API_CONFIG.endpoints),
    endpoints: API_CONFIG.endpoints
  });
});

module.exports = router;
