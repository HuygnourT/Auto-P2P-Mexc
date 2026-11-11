/**
 * Event bus trung tâm + Server-Sent Events cho dashboard.
 * Mọi thay đổi (engine, cấu hình, ads, market) phát qua đây → web cập nhật realtime,
 * Telegram đọc cùng nguồn dữ liệu.
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

const clients = new Set();
const SSE_EVENTS = ['engine', 'log', 'rowStatus', 'config', 'ads', 'market', 'connection', 'telegram', 'audit', 'marketFilter', 'bestPriceFilter'];

for (const ev of SSE_EVENTS) {
  bus.on(ev, payload => {
    const data = `event: ${ev}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of clients) {
      try { res.write(data); } catch (_) { clients.delete(res); }
    }
  });
}

function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: {"t":${Date.now()}}\n\n`);
  clients.add(res);
  const ping = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

module.exports = bus;
module.exports.sseHandler = sseHandler;
module.exports.clientCount = () => clients.size;
