const express = require('express');
const router = express.Router();
const MexcP2PService = require('../services/mexcP2P');
const whitelist = require('../services/whitelist');
const binancePrice = require('../services/binancePrice');        // ★ MỚI
const BitgetP2PService = require('../services/bitgetP2P');       // ★ MỚI
const logger = require('../utils/logger');
const config = require('../config');
const settings = require('../services/settings');   // ★ thêm cạnh các require khác
const bybitService = require('../services/bybitP2P');
const bingxService = require('../services/bingxP2P');
const { encodeMexcText, decodeMexcText, DEFAULT_AUTO_REPLY, DEFAULT_TRADE_TERMS } = require('../utils/mexcText');
const registry = require('../core/registry');   // ★ kết nối dùng chung cho engine + Telegram


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
      registry.set('mexcPrimary', service);
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
  registry.set('mexcPrimary', null);
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
      bybitConnected: bybitService.isConnected(),
      bingxConnected: bingxService.isConnected(),
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
      registry.set('mexcSecondary', service);
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
  registry.set('mexcSecondary', null);
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
// SETTINGS — Lưu cấu hình & thông tin đăng nhập
// ══════════════════════════════════════════════════════

// Các mục do engine quản lý (đọc/ghi qua /api/engine/...) và Telegram (qua /api/telegram/...)
const PROTECTED_SECTIONS = ['mexcPricer', 'bitgetPricer', 'bybitPricer', 'bingxPricer', 'telegram', 'marketFilters'];

function publicSettings() {
  const s = settings.getSettings();
  // KHÔNG bao giờ gửi Bot Token ra trình duyệt
  if (s.telegram) {
    const { botToken, ...rest } = s.telegram;
    s.telegram = { ...rest, hasToken: !!botToken };
  }
  return s;
}

router.get('/settings', (_req, res) => {
  res.json({ code: 0, data: publicSettings() });
});

router.post('/settings/:section', (req, res) => {
  if (PROTECTED_SECTIONS.includes(req.params.section)) {
    return res.status(400).json({ code: -1, msg: `Mục "${req.params.section}" được quản lý bởi engine/Telegram — dùng API riêng` });
  }
  try {
    settings.saveSection(req.params.section, req.body || {});
    res.json({ code: 0, data: publicSettings() });
  } catch (err) {
    res.status(400).json({ code: -1, msg: err.message });
  }
});

// ══════════════════════════════════════════════════════
// MEXC — Automated Reply & Advertiser Terms
//   Lưu dạng Tiếng Việt (settings.mexcAdText), khi gửi lên MEXC sẽ convert UTF-8
// ══════════════════════════════════════════════════════

function buildAdTextResponse() {
  const saved = settings.getSettings().mexcAdText || {};
  const hasSaved = typeof saved.autoReplyMsg === 'string' || typeof saved.tradeTerms === 'string';
  const autoReplyMsg = decodeMexcText(typeof saved.autoReplyMsg === 'string' ? saved.autoReplyMsg : DEFAULT_AUTO_REPLY);
  const tradeTerms = decodeMexcText(typeof saved.tradeTerms === 'string' ? saved.tradeTerms : DEFAULT_TRADE_TERMS);
  return {
    autoReplyMsg,
    tradeTerms,
    autoReplyMsgEncoded: encodeMexcText(autoReplyMsg),
    tradeTermsEncoded: encodeMexcText(tradeTerms),
    isDefault: !hasSaved,
    defaults: { autoReplyMsg: DEFAULT_AUTO_REPLY, tradeTerms: DEFAULT_TRADE_TERMS },
  };
}

router.get('/mexc/ad-text', (_req, res) => {
  res.json({ code: 0, data: buildAdTextResponse() });
});

router.post('/mexc/ad-text', (req, res) => {
  try {
    const { autoReplyMsg = '', tradeTerms = '' } = req.body || {};
    // Lưu dạng Tiếng Việt (nếu người dùng dán chuỗi đã encode thì decode lại)
    settings.saveSection('mexcAdText', {
      autoReplyMsg: decodeMexcText(String(autoReplyMsg)).replace(/\r\n/g, '\n'),
      tradeTerms: decodeMexcText(String(tradeTerms)).replace(/\r\n/g, '\n'),
      updatedAt: Date.now(),
    });
    logger.info('[MEXC] Đã lưu Automated Reply / Advertiser Terms');
    res.json({ code: 0, data: buildAdTextResponse() });
  } catch (err) {
    res.status(400).json({ code: -1, msg: err.message });
  }
});

router.post('/mexc/ad-text/reset', (_req, res) => {
  try {
    settings.saveSection('mexcAdText', {});
    res.json({ code: 0, data: buildAdTextResponse() });
  } catch (err) {
    res.status(400).json({ code: -1, msg: err.message });
  }
});

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
      registry.set('bitget', service);
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
  registry.set('bitget', null);
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
    const result = await bitgetService.getOnlineAds();
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

router.get('/bitget/ad-info', async (req, res) => {
  if (!bitgetService) {
    return res.status(401).json({ code: -1, msg: 'Bitget not connected' });
  }
  try {
    const { advId } = req.query;
    if (!advId) return res.status(400).json({ code: -1, msg: 'advId is required' });
    const result = await bitgetService.getAdInfo(advId);
    res.json(result);
  } catch (error) {
    logger.error('Bitget ad-info error:', error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

router.get('/bitget/market', async (req, res) => {
  if (!bitgetService) {
    return res.status(401).json({ code: -1, msg: 'Bitget not connected' });
  }
  try {
    const { side, token, fiat, amount, pageNum, limit } = req.query;
    if (!side) return res.status(400).json({ code: -1, msg: 'side is required' });
    const params = {
      token: token || 'USDT',
      fiat: fiat || 'VND',
      side,
      pageNum: pageNum || '1',
      limit: limit || '10',
    };
    if (amount) params.amount = amount;
    const result = await bitgetService.getAdList(params);
    res.json(result);
  } catch (error) {
    logger.error('Bitget market error:', error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

// router.get('/bitget/my-ads', async (req, res) => {
//   if (!bitgetService) {
//     return res.status(401).json({ code: -1, msg: 'Bitget not connected' });
//   }
//   try {
//     const { advId } = req.query;
//     if (!advId) return res.status(400).json({ code: -1, msg: 'advId is required' });
//     const result = await bitgetService.getAdInfo(advId);
//     res.json(result);
//   } catch (error) {
//     logger.error('Bitget ad-info error:', error.message);
//     res.status(500).json({ code: -1, msg: error.message });
//   }
// });


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

// ══════════════════════════════════════════════════════
// BYBIT P2P
// ══════════════════════════════════════════════════════

router.post('/bybit/connect', async (req, res) => {
  try {
    const { apiKey, apiSecret } = req.body || {};
    if (!apiKey || !apiSecret) return res.status(400).json({ code: -1, msg: 'Thiếu apiKey/apiSecret' });
    bybitService.connect({ apiKey, apiSecret });
    const check = await bybitService.getAccountInfo();
    if (check.ret_code !== 0) {
      bybitService.disconnect();
      return res.json({ code: -1, msg: check.ret_msg || 'Xác thực thất bại' });
    }
    require('../core/bus').emit('connection', { key: 'bybit', connected: true });
    res.json({ code: 0, msg: 'connected', data: check.result });
  } catch (err) {
    bybitService.disconnect();
    res.json({ code: -1, msg: err.message });
  }
});

router.post('/bybit/disconnect', (_req, res) => {
  bybitService.disconnect();
  require('../core/bus').emit('connection', { key: 'bybit', connected: false });
  res.json({ code: 0, msg: 'disconnected' });
});

router.get('/bybit/my-ads', async (_req, res) => {
  try {
    const r = await bybitService.getMyAds({});
    res.json(r);
  } catch (err) {
    res.json({ retCode: -1, retMsg: err.message });
  }
});

router.post('/bybit/online-ads', async (req, res) => {
  try {
    const { tokenId, currencyId, side, page, size } = req.body || {};
    if (!tokenId || !currencyId || side == null)
      return res.status(400).json({ ret_code: -1, ret_msg: 'Thiếu tokenId/currencyId/side' });
    const r = await bybitService.getOnlineAds({ tokenId, currencyId, side: String(side), page, size });
    res.json(r);
  } catch (err) {
    res.json({ ret_code: -1, ret_msg: err.message });
  }
});

router.post('/bybit/ads/update', async (req, res) => {
  try {
    const r = await bybitService.updateAd(req.body || {});
    res.json(r);
  } catch (err) {
    res.json({ ret_code: -1, ret_msg: err.message });
  }
});

router.get('/bybit/payments', async (_req, res) => {
  try {
    const r = await bybitService.getUserPayments();
    res.json(r);
  } catch (err) {
    res.json({ ret_code: -1, ret_msg: err.message });
  }
});

// ══════════════════════════════════════════════════════
// BINGX P2P
// ══════════════════════════════════════════════════════

function requireBingx(_req, res, next) {
  if (!bingxService.isConnected()) return res.status(400).json({ code: -1, msg: 'BingX chưa kết nối' });
  next();
}

router.post('/bingx/connect', async (req, res) => {
  const { apiKey, secretKey, postMode } = req.body || {};
  if (!apiKey || !secretKey) return res.status(400).json({ code: -1, msg: 'Thiếu API Key / Secret Key' });
  try {
    bingxService.connect({ apiKey: apiKey.trim(), secretKey: secretKey.trim(), postMode });
    const check = await bingxService.getMyAdsAll();
    if (check.code !== 0) {
      bingxService.disconnect();
      const hint = bingxService.explain(check);
      return res.json({ code: check.code || -1, msg: `${check.msg || 'Kết nối BingX thất bại'}${hint ? ' — ' + hint : ''}` });
    }
    logger.info(`[BingX] Connected — ${check.data.total} ads`);
    require('../core/bus').emit('connection', { key: 'bingx', connected: true });
    res.json({ code: 0, data: check.data });
  } catch (err) {
    bingxService.disconnect();
    logger.error('[BingX] connect error:', err.message);
    res.status(500).json({ code: -1, msg: err.message });
  }
});

// Kiểm tra kết nối từng bước (dùng key trên form, không cần đang kết nối)
router.post('/bingx/diagnose', async (req, res) => {
  const { apiKey, secretKey } = req.body || {};
  if (!apiKey || !secretKey) return res.status(400).json({ code: -1, msg: 'Thiếu API Key / Secret Key' });
  try {
    res.json({ code: 0, data: await bingxService.diagnose({ apiKey: apiKey.trim(), secretKey: secretKey.trim() }) });
  } catch (err) {
    res.status(500).json({ code: -1, msg: err.message });
  }
});

router.post('/bingx/disconnect', (_req, res) => {
  bingxService.disconnect();
  require('../core/bus').emit('connection', { key: 'bingx', connected: false });
  res.json({ code: 0 });
});

// Ads của tôi: gồm cả Listed (online) và Delisted (offline)
router.get('/bingx/my-ads', requireBingx, async (_req, res) => {
  try {
    res.json(await bingxService.getMyAdsAll());
  } catch (err) {
    res.status(500).json({ code: -1, msg: err.message });
  }
});

// Market: tradeType 1 = người dùng mua (ads BÁN của merchant), 2 = người dùng bán (ads MUA)
router.get('/bingx/market', async (req, res) => {
  try {
    const { asset = 'USDT', fiatUnit = 'VND', tradeType, pages = 3 } = req.query;
    if (!['1', '2'].includes(String(tradeType))) return res.status(400).json({ code: -1, msg: 'tradeType phải là 1 hoặc 2' });
    const r = await bingxService.getMarketAdsAll({
      asset, fiatUnit, tradeType: Number(tradeType), pages: Math.min(10, Math.max(1, parseInt(pages) || 3)),
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ code: -1, msg: err.message });
  }
});

// Đổi giá ad (3.8 Edit P2P ads) — server tự ghép các field bắt buộc từ ad hiện tại
router.post('/bingx/ads/update-price', requireBingx, async (req, res) => {
  try {
    const { advertNo, price, minAmount, maxAmount, totalNumber } = req.body || {};
    if (!advertNo || price === undefined || price === '') return res.status(400).json({ code: -1, msg: 'Thiếu advertNo / price' });
    logger.info(`[BingX] Update price advertNo=${advertNo} price=${price}`);
    res.json(await bingxService.updateAdPrice({ advertNo, price, minAmount, maxAmount, totalNumber }));
  } catch (err) {
    logger.error('[BingX] update-price error:', err.message);
    res.status(500).json({ code: -1, msg: err.message });
  }
});

module.exports = router;
