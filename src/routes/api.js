const express = require('express');
const router = express.Router();
const MexcP2PService = require('../services/mexcP2P');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * activeService   — kết nối chính: dùng cho My Ads và các thao tác cá nhân.
 * secondaryService — kết nối phụ: dùng riêng để lấy Market Ads.
 */
let activeService = null;
let secondaryService = null;

// ══════════════════════════════════════════════════════
// KẾT NỐI CHÍNH (Primary)
// ══════════════════════════════════════════════════════

/**
 * POST /api/connect
 * Khởi tạo kết nối chính. Dùng cho My Ads và các thao tác cá nhân.
 */
router.post('/connect', async (req, res) => {
  try {
    const { apiKey, secretKey, apiHost } = req.body;

    if (!apiKey || !secretKey) {
      return res.status(400).json({ code: -1, msg: 'API Key and Secret Key are required' });
    }

    const host = apiHost || 'api.mexc.com';
    const service = new MexcP2PService(apiKey, secretKey, host);

    const connected = await service.testConnection();
    if (connected) {
      activeService = service;
      logger.info(`[Primary] Connected to MEXC P2P via ${host}`);
      return res.json({ code: 0, msg: 'Connected successfully', data: { host } });
    } else {
      return res.json({ code: -1, msg: 'Connection failed. Check your credentials.' });
    }
  } catch (error) {
    logger.error('Connect error:', error.message);
    return res.status(500).json({ code: -1, msg: error.message });
  }
});

/**
 * POST /api/disconnect
 * Ngắt kết nối chính.
 */
router.post('/disconnect', (_req, res) => {
  activeService = null;
  logger.info('[Primary] Disconnected from MEXC P2P');
  res.json({ code: 0, msg: 'Disconnected' });
});

/**
 * GET /api/status
 * Trạng thái kết nối chính + phụ.
 */
router.get('/status', (_req, res) => {
  res.json({
    code: 0,
    data: {
      connected: !!activeService,
      secondaryConnected: !!secondaryService,
    },
  });
});

// ══════════════════════════════════════════════════════
// KẾT NỐI PHỤ (Secondary) — dùng để lấy Market Ads
// ══════════════════════════════════════════════════════

/**
 * POST /api/connect/secondary
 * Khởi tạo kết nối phụ. Dùng riêng để lấy danh sách quảng cáo từ P2P Market.
 */
router.post('/connect/secondary', async (req, res) => {
  try {
    const { apiKey, secretKey, apiHost } = req.body;

    if (!apiKey || !secretKey) {
      return res.status(400).json({ code: -1, msg: 'API Key and Secret Key are required' });
    }

    const host = apiHost || 'api.mexc.com';
    const service = new MexcP2PService(apiKey, secretKey, host);

    const connected = await service.testConnection();
    if (connected) {
      secondaryService = service;
      logger.info(`[Secondary] Connected to MEXC P2P via ${host}`);
      return res.json({ code: 0, msg: 'Secondary connected successfully', data: { host } });
    } else {
      return res.json({ code: -1, msg: 'Secondary connection failed. Check your credentials.' });
    }
  } catch (error) {
    logger.error('Secondary connect error:', error.message);
    return res.status(500).json({ code: -1, msg: error.message });
  }
});

/**
 * POST /api/disconnect/secondary
 * Ngắt kết nối phụ.
 */
router.post('/disconnect/secondary', (_req, res) => {
  secondaryService = null;
  logger.info('[Secondary] Disconnected from MEXC P2P');
  res.json({ code: 0, msg: 'Secondary disconnected' });
});

// ══════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════

function requireConnection(req, res, next) {
  if (!activeService) {
    return res.status(401).json({ code: -1, msg: 'Not connected. Please enter API credentials.' });
  }
  next();
}

function requireSecondaryConnection(_req, res, next) {
  if (!secondaryService) {
    return res.status(401).json({ code: -1, msg: 'Secondary not connected. Please enter secondary API credentials.' });
  }
  next();
}

// ══════════════════════════════════════════════════════
// MARKET ADS — dùng kết nối PHỤ
// ══════════════════════════════════════════════════════

/**
 * GET /api/market/ads
 * Lấy danh sách quảng cáo BUY/SELL từ P2P Market.
 * Sử dụng secondaryService (kết nối phụ).
 */
router.get('/market/ads', requireSecondaryConnection, async (req, res) => {
  try {
    const { side, fiatUnit, coinId, page, amount, payMethod, blockTrade, allowTrade, countryCode } = req.query;

    if (!side) {
      return res.status(400).json({ code: -1, msg: 'side parameter is required (BUY or SELL)' });
    }

    const result = await secondaryService.getMarketAds({
      side: side.toUpperCase(),
      fiatUnit: fiatUnit || 'VND',
      coinId: coinId || '',
      page: parseInt(page) || 1,
      amount: amount || '',
      payMethod: payMethod || '',
      blockTrade: blockTrade !== undefined ? blockTrade === 'true' : true,
      allowTrade: allowTrade !== undefined ? allowTrade === 'true' : true,
      countryCode: countryCode || 'VN',
    });

    res.json(result);
  } catch (error) {
    logger.error('Market ads error:', error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

// ══════════════════════════════════════════════════════
// MY ADS — dùng kết nối CHÍNH
// ══════════════════════════════════════════════════════

/**
 * GET /api/my/ads
 * Lấy danh sách quảng cáo của bản thân (merchant ads).
 * Sử dụng activeService (kết nối chính).
 */
router.get('/my/ads', requireConnection, async (req, res) => {
  try {
    const { advStatus, coinId, page, limit } = req.query;

    const result = await activeService.getMyAds({
      advStatus: advStatus || '',
      coinId: coinId || config.defaultCoinId,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 10,
    });

    res.json(result);
  } catch (error) {
    logger.error('My ads error:', error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

/**
 * POST /api/my/ads/update
 * Cập nhật quảng cáo P2P hiện có.
 * Sử dụng activeService (kết nối chính).
 */
router.post('/my/ads/update', requireConnection, async (req, res) => {
  try {
    const adData = req.body;

    if (!adData.advNo) {
      return res.status(400).json({ code: -1, msg: 'advNo is required for updating' });
    }

    logger.info(`[Update Ad] advNo=${adData.advNo}, price=${adData.price}`);
    const result = await activeService.saveOrUpdateAd(adData);
    res.json(result);
  } catch (error) {
    logger.error('Update ad error:', error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

module.exports = router;
