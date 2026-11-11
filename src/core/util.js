/**
 * Tiện ích dùng chung cho engine / Telegram / routes.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Khóa theo key (vd "bybit:12345"): các thao tác trên cùng 1 ad chạy tuần tự ──
const lockTails = new Map();
async function withLock(key, fn) {
  const prev = lockTails.get(key) || Promise.resolve();
  let release;
  const mine = new Promise(r => { release = r; });
  const tail = prev.then(() => mine);
  lockTails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}

// ── Giãn cách request theo từng sàn (tránh vượt rate limit khi engine + web + Telegram cùng gọi) ──
const MIN_GAP_MS = { mexc: 120, bitget: 120, bybit: 100, bingx: 120 };
const lastCall = {};
const gapQueue = {};
function throttle(ex) {
  const gap = MIN_GAP_MS[ex] || 100;
  const run = (gapQueue[ex] || Promise.resolve()).then(async () => {
    const wait = (lastCall[ex] || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall[ex] = Date.now();
  });
  gapQueue[ex] = run.catch(() => {});
  return run;
}

// ── Số ──
const isBlank = v => v === '' || v === null || v === undefined;
function num(v) {
  if (isBlank(v)) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Đọc số người dùng nhập (Telegram): "26,100" "26.100" "26100" "1,5" "1.5" "20k"
 * Trả null nếu không hợp lệ.
 */
function parseUserNumber(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/\s+/g, '').replace(/vnd|usdt|đ/gi, '');
  if (!s) return null;
  let mult = 1;
  if (/k$/i.test(s)) { mult = 1e3; s = s.slice(0, -1); }
  else if (/m$/i.test(s)) { mult = 1e6; s = s.slice(0, -1); }
  else if (/(tr|triệu|trieu)$/i.test(s)) { mult = 1e6; s = s.replace(/(tr|triệu|trieu)$/i, ''); }
  if (!/^-?[\d.,]+$/.test(s)) return null;
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) {
    // Dấu phân cách hàng nghìn kiểu VN/US: 26,100 | 26.100 | 1.234.567 → 26100 / 1234567
    s = s.replace(/[.,]/g, '');
  } else {
    // Còn lại: tối đa 1 dấu , hoặc . là phần thập phân (1,5 | 0.25)
    if ((s.match(/[.,]/g) || []).length > 1) return null;
    s = s.replace(',', '.');
  }
  const n = parseFloat(s) * mult;
  return Number.isFinite(n) ? n : null;
}

function fmt(n, digits = 0) {
  const v = num(n);
  if (v === null) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function shortId(id) {
  const s = String(id || '');
  return s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-5)}` : s;
}

module.exports = { sleep, withLock, throttle, isBlank, num, parseUserNumber, fmt, shortId };
