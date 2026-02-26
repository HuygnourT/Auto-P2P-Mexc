require('dotenv').config();

const config = {
  // Cổng chạy server, mặc định 3000
  port: process.env.PORT || 3000,

  // Host API mặc định, có thể thay đổi qua giao diện
  defaultApiHost: process.env.MEXC_API_HOST || 'api.mexc.com',

  // Danh sách 2 cổng API để người dùng chọn
  apiHosts: [
    { label: 'Global (api.mexc.com)', value: 'api.mexc.com' },
    { label: 'Alternative (api.mexc.co)', value: 'api.mexc.co' },
  ],

  // Tiền tệ fiat mặc định khi lấy ads market
  defaultFiatUnit: 'VND',
  defaultCoinId: 'USDT',

  // Giới hạn request tối đa mỗi giây (theo tài liệu MEXC API)
  maxRequestsPerSecond: 10,
};

module.exports = config;
