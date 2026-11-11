/**
 * Cấu hình Telegram Bot từ dashboard. Bot Token chỉ được GỬI LÊN, không bao giờ trả về trình duyệt.
 */
const express = require('express');
const router = express.Router();
const bot = require('../telegram/bot');

router.get('/telegram/status', (_req, res) => {
  res.json({ code: 0, data: bot.status() });
});

router.post('/telegram/config', async (req, res) => {
  try {
    const { botToken, userId, chatId, enabled } = req.body || {};
    const data = await bot.configure({ botToken, userId, chatId, enabled });
    res.json({ code: 0, data });
  } catch (err) {
    res.status(400).json({ code: -1, msg: err.message });
  }
});

router.post('/telegram/test', async (_req, res) => {
  const r = await bot.test();
  res.json({ code: r.ok ? 0 : -1, msg: r.msg, data: bot.status() });
});

module.exports = router;
