const config = require('../config');

/**
 * Lưu trữ số lượng request theo IP trong 1 giây gần nhất.
 * Key = IP address, Value = mảng timestamp của các request.
 */
const requestCounts = new Map();

/**
 * Middleware giới hạn tốc độ request (Rate Limiter).
 * Theo tài liệu MEXC API, tối đa 10 request/giây.
 * Nếu vượt quá giới hạn, trả về HTTP 429 (Too Many Requests).
 * Hoạt động: đếm số request từ cùng 1 IP trong cửa sổ 1 giây.
 */
// Chỉ giới hạn các request đi tới MEXC. Các sàn khác (Bitget/Bybit/BingX) có giới hạn riêng,
// còn file tĩnh và các API nội bộ (settings, status, whitelist...) không gọi ra ngoài.
const SKIP_PREFIXES = ['/api/bitget', '/api/bybit', '/api/bingx', '/api/settings', '/api/status',
  '/api/config', '/api/whitelist', '/api/binance', '/api/mexc/ad-text',
  // engine chạy trong server và tự giãn cách request tới sàn; SSE là kết nối dài
  '/api/engine', '/api/events', '/api/telegram', '/api/market/best', '/api/market/list', '/api/audit'];
const MEXC_PREFIXES = ['/api/'];

function rateLimiter(req, res, next) {
  const url = req.originalUrl || req.url || '';
  if (!MEXC_PREFIXES.some(p => url.startsWith(p)) || SKIP_PREFIXES.some(p => url.startsWith(p))) return next();
  const now = Date.now();
  const windowMs = 1000; // Cửa sổ thời gian: 1 giây
  const key = req.ip;

  if (!requestCounts.has(key)) {
    requestCounts.set(key, []);
  }

  // Lọc chỉ giữ lại các timestamp trong 1 giây gần nhất
  const timestamps = requestCounts.get(key).filter(t => now - t < windowMs);

  // Nếu đã đạt giới hạn, từ chối request
  if (timestamps.length >= config.maxRequestsPerSecond) {
    return res.status(429).json({
      code: -1,
      msg: 'Rate limit exceeded. Max 10 requests per second.',
    });
  }

  // Ghi nhận request hiện tại và cho phép đi tiếp
  timestamps.push(now);
  requestCounts.set(key, timestamps);
  next();
}

module.exports = rateLimiter;
