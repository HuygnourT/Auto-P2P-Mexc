const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const rateLimiter = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

const app = express();

// ── Middleware toàn cục ──
app.use(cors());                                  // Cho phép cross-origin requests
app.use(express.json());                          // Parse body JSON
app.use(express.urlencoded({ extended: true }));  // Parse form data
app.use(rateLimiter);                             // Giới hạn 10 req/s

// ── Phục vụ file tĩnh (HTML, CSS, JS) từ thư mục public ──
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Gắn các route API vào prefix /api ──
app.use('/api', apiRoutes);

/**
 * GET /api/config
 * Chức năng: Trả về cấu hình cho frontend (danh sách API host, fiat mặc định).
 * Frontend gọi khi load trang để render dropdown chọn host.
 */
app.get('/api/config', (req, res) => {
  res.json({
    code: 0,
    data: {
      apiHosts: config.apiHosts,
      defaultFiatUnit: config.defaultFiatUnit,
    },
  });
});

/**
 * Fallback: Mọi route không khớp sẽ trả về index.html (SPA pattern).
 * Giúp frontend xử lý routing phía client nếu cần mở rộng.
 */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Khởi động server ──
app.listen(config.port, () => {
  logger.info(`MEXC P2P System running on http://localhost:${config.port}`);
});

module.exports = app;
