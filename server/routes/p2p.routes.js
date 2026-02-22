// server/routes/p2p.routes.js
const express = require('express');
const router = express.Router();
const P2PService = require('../services/p2p.service');
const API_CONFIG = require('../config/api.config');

/**
 * Validate gateway helper
 */
function resolveGateway(req, res) {
  const gateway = req.query.gateway || 'mexc.com';
  if (!API_CONFIG.endpoints[gateway]) {
    res.status(400).json({
      success: false,
      error: `Invalid gateway. Choose from: ${Object.keys(API_CONFIG.endpoints).join(', ')}`
    });
    return null;
  }
  return gateway;
}

/**
 * GET /api/p2p/ads
 * Get market ads — both sides or filtered by side
 * Query: side, fiatUnit, coinId, page, amount, quantity, countryCode, payMethod, gateway
 */
router.get('/ads', async (req, res) => {
  const gateway = resolveGateway(req, res);
  if (!gateway) return;

  try {
    const {
      side,
      fiatUnit = API_CONFIG.defaults.fiatUnit,
      coinId = 'USDT',
      page = 1,
      amount,
      quantity,
      countryCode,
      payMethod
    } = req.query;

    const p2pService = new P2PService(gateway);

    let result;
    if (!side) {
      result = await p2pService.getBothSidesAds({ fiatUnit, coinId, page, amount, quantity, countryCode, payMethod });
    } else {
      const sideUpper = side.toUpperCase();
      if (!['BUY', 'SELL'].includes(sideUpper)) {
        return res.status(400).json({ success: false, error: 'side must be BUY or SELL' });
      }
      result = await p2pService.getMarketAds({ side: sideUpper, fiatUnit, coinId, page, amount, quantity, countryCode, payMethod });
    }

    res.json({
      success: true,
      data: result,
      gateway,
      filters: { fiatUnit, coinId, side, page, amount, quantity }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/p2p/ads/buy
 * Get BUY side ads only
 */
router.get('/ads/buy', async (req, res) => {
  const gateway = resolveGateway(req, res);
  if (!gateway) return;

  try {
    const { fiatUnit = 'VND', coinId = 'USDT', page = 1, amount, quantity } = req.query;
    const result = await new P2PService(gateway).getMarketAds({ side: 'BUY', fiatUnit, coinId, page, amount, quantity });
    res.json({ success: true, data: result, side: 'BUY' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/p2p/ads/sell
 * Get SELL side ads only
 */
router.get('/ads/sell', async (req, res) => {
  const gateway = resolveGateway(req, res);
  if (!gateway) return;

  try {
    const { fiatUnit = 'VND', coinId = 'USDT', page = 1, amount, quantity } = req.query;
    const result = await new P2PService(gateway).getMarketAds({ side: 'SELL', fiatUnit, coinId, page, amount, quantity });
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
