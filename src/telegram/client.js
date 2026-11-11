/**
 * Client gọi Telegram Bot API (HTTPS, long polling — không cần domain/webhook).
 * Token chỉ nằm trong bộ nhớ server; mọi thông báo lỗi đều được che token trước khi log.
 */
const axios = require('axios');

class TelegramClient {
  constructor(token) {
    this.token = token;
    this.base = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  }

  sanitize(text) {
    let s = String(text ?? '');
    if (this.token) s = s.split(this.token).join('<token>');
    return s.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot<token>');
  }

  async call(method, params = {}, { timeoutMs = 15000 } = {}) {
    try {
      const res = await axios.post(`${this.base}/bot${this.token}/${method}`, params, {
        timeout: timeoutMs,
        validateStatus: () => true,
        headers: { 'Content-Type': 'application/json' },
      });
      const body = res.data || {};
      if (!body.ok) {
        const err = new Error(this.sanitize(`Telegram ${method}: ${body.description || `HTTP ${res.status}`}`));
        err.tgCode = body.error_code || res.status;
        err.retryAfter = body.parameters?.retry_after;
        throw err;
      }
      return body.result;
    } catch (err) {
      if (err.tgCode) throw err;
      const e = new Error(this.sanitize(`Telegram ${method}: ${err.code || ''} ${err.message}`));
      e.network = true;
      throw e;
    }
  }
}

module.exports = TelegramClient;
