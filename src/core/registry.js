/**
 * Nơi giữ các kết nối sàn đang hoạt động, dùng chung cho routes, engine và Telegram.
 *
 *  mexcPrimary   — MEXC API chính (ads của tôi, sửa ad)
 *  mexcSecondary — MEXC API phụ (market ads)
 *  bitget        — Bitget P2P
 *  bybit / bingx — service singleton (tự quản lý trạng thái kết nối)
 */
const bybitService = require('../services/bybitP2P');
const bingxService = require('../services/bingxP2P');
const bus = require('./bus');

const conns = { mexcPrimary: null, mexcSecondary: null, bitget: null };

function set(key, service) {
  conns[key] = service || null;
  bus.emit('connection', { key, connected: !!service });
}
function get(key) { return conns[key]; }

function status() {
  return {
    mexc: !!conns.mexcPrimary,
    mexcSecondary: !!conns.mexcSecondary,
    bitget: !!conns.bitget,
    bybit: bybitService.isConnected(),
    bingx: bingxService.isConnected(),
  };
}

module.exports = { set, get, status, bybit: bybitService, bingx: bingxService };
