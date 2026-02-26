const express = require('express');
const router = express.Router();
const MexcP2PService = require('../services/mexcP2P');
const logger = require('../utils/logger');
const config = require('../config');

/**
 * Biến lưu service instance đang kết nối.
 * Khi người dùng nhập API Key và kết nối thành công, service được lưu ở đây.
 * Khi disconnect, biến này được set về null.
 * (Lưu ý: đây là in-memory, phù hợp cho single-user. Production nên dùng session.)
 */
let activeService = null;

/**
 * POST /api/connect
 * Chức năng: Khởi tạo kết nối đến MEXC API.
 * Nhận apiKey, secretKey, apiHost từ body.
 * Tạo MexcP2PService instance, gọi testConnection() để kiểm tra.
 * Nếu thành công, lưu service vào activeService để các route khác sử dụng.
 */
router.post('/connect', async (req, res) => {
  try {
    const { apiKey, secretKey, apiHost } = req.body;

    if (!apiKey || !secretKey) {
      return res.status(400).json({ code: -1, msg: 'API Key and Secret Key are required' });
    }

    const host = apiHost || 'api.mexc.com';
    const service = new MexcP2PService(apiKey, secretKey, host);

    // Thử kết nối bằng cách gọi 1 API đơn giản
    const connected = await service.testConnection();
    if (connected) {
      activeService = service;
      logger.info(`Connected to MEXC P2P via ${host}`);
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
 * Chức năng: Ngắt kết nối, xóa service instance.
 * Sau khi gọi, các route yêu cầu kết nối sẽ bị chặn bởi middleware requireConnection.
 */
router.post('/disconnect', (req, res) => {
  activeService = null;
  logger.info('Disconnected from MEXC P2P');
  res.json({ code: 0, msg: 'Disconnected' });
});

/**
 * GET /api/status
 * Chức năng: Kiểm tra trạng thái kết nối hiện tại.
 * Frontend gọi khi load trang để biết đã kết nối hay chưa.
 */
router.get('/status', (req, res) => {
  res.json({
    code: 0,
    data: { connected: !!activeService },
  });
});

/**
 * Middleware: Yêu cầu phải kết nối trước khi truy cập các route market.
 * Nếu chưa kết nối (activeService === null), trả 401 và yêu cầu nhập credentials.
 */
function requireConnection(req, res, next) {
  if (!activeService) {
    return res.status(401).json({ code: -1, msg: 'Not connected. Please enter API credentials.' });
  }
  next();
}

/**
 * GET /api/market/ads
 * Chức năng: Lấy danh sách quảng cáo BUY hoặc SELL trên market P2P.
 * Query params: side (BUY/SELL), fiatUnit (VND/USD/...), coinId, page, amount, payMethod.
 * Đây là route chính hiển thị bảng ads trên giao diện.
 */
router.get('/market/ads', requireConnection, async (req, res) => {
  try {
    const { side, fiatUnit, coinId, page, amount, payMethod } = req.query;

    if (!side) {
      return res.status(400).json({ code: -1, msg: 'side parameter is required (BUY or SELL)' });
    }

    const result = await activeService.getMarketAds({
      side: side.toUpperCase(),
      fiatUnit: fiatUnit || 'VND',
      coinId: coinId || config.defaultCoinId,
      page: parseInt(page) || 1,
      amount: amount || '',
      payMethod: payMethod || '',
    });

    res.json(result);
  } catch (error) {
    logger.error('Market ads error:', error.message);
    res.status(500).json({ code: -1, msg: error.message });
  }
});

/**
 * GET /api/my/ads
 * Chức năng: Lấy danh sách quảng cáo của bản thân (merchant ads).
 * Query params: advStatus (OPEN/CLOSE), coinId, page, limit.
 * Dùng cho trang quản lý ads cá nhân (sẽ phát triển thêm).
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

module.exports = router;
