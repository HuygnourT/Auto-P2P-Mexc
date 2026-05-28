const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const rateLimiter = require('./middleware/rateLimiter');
const binancePrice = require('./services/binancePrice');          // ★ MỚI
const logger = require('./utils/logger');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimiter);

app.use(express.static(path.join(__dirname, '..', 'public')));

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
  logger.info(`MEXC P2P System running on http://localhost:${config.port}`);
});

module.exports = app;
