const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const engineRoutes = require('./routes/engine');                 // ★ engine + market + SSE dùng chung
const telegramRoutes = require('./routes/telegram');             // ★ cấu hình Telegram Bot
const telegramBot = require('./telegram/bot');
const rateLimiter = require('./middleware/rateLimiter');
const binancePrice = require('./services/binancePrice');          // ★ MỚI
const logger = require('./utils/logger');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimiter);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', engineRoutes);
app.use('/api', telegramRoutes);
app.use('/api', apiRoutes);

app.get('/api/config', (req, res) => {
  res.json({
    code: 0,
    data: {
      apiHosts: config.apiHosts,
      defaultFiatUnit: config.defaultFiatUnit,
    },
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ★ MỚI: Bắt đầu polling giá Binance từ pricedancing.com mỗi 60s
binancePrice.startPolling(60000);

app.listen(config.port, () => {
  logger.info(`P2P Auto System running on http://localhost:${config.port}`);
  // Telegram Bot chạy độc lập: lỗi/mất kết nối Telegram KHÔNG ảnh hưởng engine tự chỉnh giá
  telegramBot.startFromSettings().catch(err => logger.error('[Telegram] start error:', err.message));
});

// Không để lỗi bất ngờ (vd Telegram/mạng) làm sập toàn bộ app
process.on('unhandledRejection', err => logger.error('[Process] unhandledRejection:', err?.message || err));

module.exports = app;
