const crypto = require('crypto');
const logger = require('../utils/logger');

const RECV_WINDOW = '5000';

class BybitP2P {
  constructor() {
    this.apiKey = null;
    this.apiSecret = null;
    this.baseUrl = 'https://api.bybit.com';
    this.connected = false;
  }

  connect({ apiKey, apiSecret }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.connected = true;
  }

  disconnect() {
    this.apiKey = null;
    this.apiSecret = null;
    this.connected = false;
  }

  isConnected() { return this.connected; }

  // Ký: timestamp + apiKey + recvWindow + payload
  _sign(timestamp, payload) {
    const str = timestamp + this.apiKey + RECV_WINDOW + payload;
    return crypto.createHmac('sha256', this.apiSecret).update(str).digest('hex');
  }

  async _post(endpoint, bodyObj = {}) {
    if (!this.connected) throw new Error('Bybit chưa kết nối');
    const timestamp = Date.now().toString();
    const body = JSON.stringify(bodyObj);
    const sign = this._sign(timestamp, body);

    const res = await fetch(this.baseUrl + endpoint, {
      method: 'POST',
      headers: {
        'X-BAPI-API-KEY': this.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': sign,
        'Content-Type': 'application/json',
      },
      body,
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      logger.error(`[Bybit] ${endpoint} HTTP ${res.status} — phản hồi không phải JSON: ${text.slice(0, 300)}`);
      throw new Error(`Bybit trả về không phải JSON (HTTP ${res.status})`);
    }

    if (data.ret_code !== 0) {
      logger.error(`[Bybit] ${endpoint} ret_code=${data.ret_code} msg=${data.ret_msg} | raw=${text.slice(0, 300)}`);
    }
    return data;
  }

  // Kiểm tra kết nối bằng cách lấy thông tin tài khoản P2P
  async getAccountInfo() {
    return this._post('/v5/p2p/user/personal/info', {});
  }

  // Lấy danh sách ad của mình. Body params (tùy chọn): status, side, tokenId, page, size...
  async getMyAds(params = {}) {
    return this._post('/v5/p2p/item/personal/list', params);
  }

  async getAdDetail(itemId) {
    return this._post('/v5/p2p/item/info', { itemId });
  }

  // Lấy ads thị trường. Params bắt buộc: tokenId, currencyId, side ('0' buy/'1' sell)
  async getOnlineAds({ tokenId, currencyId, side, page = '1', size = '10' }) {
    return this._post('/v5/p2p/item/online', { tokenId, currencyId, side, page, size });
  }

  // Cập nhật ad. bodyObj phải đủ field theo tài liệu (xem route).
  async updateAd(bodyObj) {
    return this._post('/v5/p2p/item/update', bodyObj);
  }

  // Lấy phương thức thanh toán của tài khoản (để có paymentIds hợp lệ)
  async getUserPayments() {
    return this._post('/v5/p2p/user/payment/list', {});
  }
}

module.exports = new BybitP2P();