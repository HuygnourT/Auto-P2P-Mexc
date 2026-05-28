const express = require('express');
const router = express.Router();
const MexcP2PService = require('../services/mexcP2P');
const whitelist = require('../services/whitelist');
const binancePrice = require('../services/binancePrice');        // ★ MỚI
const BitgetP2PService = require('../services/bitgetP2P');       // ★ MỚI
const logger = require('../utils/logger');
const config = require('../config');

/**
 * activeService    — kết nối chính MEXC: dùng cho My Ads và các thao tác cá nhân.
 * secondaryService — kết nối phụ MEXC: dùng riêng để lấy Market Ads.
 * bitgetService    — kết nối Bitget P2P.
 */
let activeService = null;
let secondaryService = null;
let bitgetService = null;                                        // ★ MỚI

// ══════════════════════════════════════════════════════
// KẾT NỐI CHÍNH (Primary) — MEXC
// ══════════════════════════════════════════════════════

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

router.post('/disconnect', (_req, res) => {
  activeService = null;
  logger.info('[Primary] Disconnected from MEXC P2P');
  res.json({ code: 0, msg: 'Disconnected' });
});

router.get('/status', (_req, res) => {
  res.json({
    code: 0,
    data: {
      connected: !!activeService,
      secondaryConnected: !!secondaryService,
      bitgetConnected: !!bitgetService,                          // ★ MỚI
    },
  });
});

// ══════════════════════════════════════════════════════
// KẾT NỐI PHỤ (Secondary) — MEXC Market Ads
// ══════════════════════════════════════════════════════

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
// WHITELIST — Danh sách thương nhân bỏ qua
// ══════════════════════════════════════════════════════

router.get('/whitelist', (_req, res) => {
  const merchants = whitelist.getWhitelist();
  res.json({ code: 0, data: merchants });
});

router.post('/whitelist/add', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ code: -1, msg: 'name is required' });
  }
  const merchants = whitelist.addMerchant(name);
  res.json({ code: 0, data: merchants });
});

router.post('/whitelist/remove', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ code: -1, msg: 'name is required' });
  }
  const merchants = whitelist.removeMerchant(name);
  res.json({ code: 0, data: merchants });
});

// ══════════════════════════════════════════════════════
// ★ MỚI: BINANCE PRICE — Giá từ pricedancing.com
// ══════════════════════════════════════════════════════

router.get('/binance/price', (_req, res) => {
  res.json({ code: 0, data: binancePrice.getPrice() });
});

// ══════════════════════════════════════════════════════
// ★ MỚI: BITGET P2P
// ══════════════════════════════════════════════════════

router.post('/bitget/connect', async (req, res) => {
  try {
    const { apiKey, secretKey, passphrase } = req.body;
    if (!apiKey || !secretKey || !passphrase) {
      return res.status(400).json({ code: -1, msg: 'apiKey, secretKey, passphrase are required' });
    }
    const service = new BitgetP2PService(apiKey, secretKey, passphrase);
    const connected = await service.testConnection();
    if (connected) {
      bitgetService = service;
      logger.info('[Bitget] Connected');
      return res.json({ code: 0, msg: 'Bitget connected' });
    } else {
      return res.json({ code: -1, msg: 'Bitget connection failed. Check credentials.' });
    }
  } catch (error) {
    logger.error('Bitget connect error:', error.message);
    return res.status(500).json({ code: -1, msg: error.message });
  }
});

router.post('/bitget/disconnect', (_req, res) => {
  bitgetService = null;
  logger.info('[Bitget] Disconnected');
  res.json({ code: 0, msg: 'Bitget disconnected' });
});

router.get('/bitget/status', (_req, res) => {
  res.json({ code: 0, data: { connected: !!bitgetService } });
});

router.get('/bitget/ads', async (req, res) => {
  if (!bitgetService) {
    return res.status(401).json({ code: -1, msg: 'Bitget not connected' });
  }
  try {
    const result = await bitgetService.getAdvList(req.query);
    res.json(result);
  } catch (error) {
    logger.error('Bitget ads error:', error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

router.post('/bitget/ads/update', async (req, res) => {
  if (!bitgetService) {
    return res.status(401).json({ code: -1, msg: 'Bitget not connected' });
  }
  try {
    const result = await bitgetService.updateAd(req.body);
    res.json(result);
  } catch (error) {
    logger.error('Bitget update ad error:', error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

// ══════════════════════════════════════════════════════
// MARKET ADS — dùng kết nối PHỤ (MEXC)
// ══════════════════════════════════════════════════════

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
// MY ADS — dùng kết nối CHÍNH (MEXC)
// ══════════════════════════════════════════════════════

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
