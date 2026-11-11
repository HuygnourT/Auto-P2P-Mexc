/**
 * TELEGRAM BOT — quản lý quảng cáo P2P từ xa.
 *
 *  - Long polling (getUpdates) trong cùng tiến trình với engine; lỗi Telegram không ảnh hưởng engine
 *  - Chỉ chấp nhận đúng User ID + Chat ID đã cấu hình; từ chối mọi người khác
 *  - Mọi thay đổi đi qua core/ops (cùng quy tắc, cùng cấu hình, cùng engine với web)
 *  - Sửa quảng cáo luôn cần bấm Xác nhận; mỗi nút xác nhận chỉ dùng được 1 lần
 *  - Không bao giờ gửi API key/secret/token trong tin nhắn
 */
const crypto = require('crypto');
const TelegramClient = require('./client');
const settings = require('../services/settings');
const logger = require('../utils/logger');
const bus = require('../core/bus');
const store = require('../core/store');
const engine = require('../core/engine');
const market = require('../core/market');
const adapters = require('../core/adapters');
const ops = require('../core/ops');
const audit = require('../core/audit');
const { parseUserNumber, fmt, sleep } = require('../core/util');

const EXS = ['mexc', 'bybit', 'bitget', 'bingx'];
const LABEL = { mexc: 'MEXC', bybit: 'Bybit', bitget: 'Bitget', bingx: 'BingX' };
const ADS_PER_PAGE = 4;
const MARKET_PER_PAGE = 8;
const PENDING_TTL = 5 * 60 * 1000;
const QTY_FILTERS = [0, 100, 500, 1000, 5000];

const st = {
  client: null, running: false, enabled: false, loopId: 0,
  offset: 0, me: null, lastOkAt: null, lastError: null, lastErrorAt: null, startedAt: null,
};
const sessions = new Map();     // chatId → { awaiting, lastBest }
const pending = new Map();      // token → thao tác chờ xác nhận
const seenCallbacks = new Set();
const deniedAt = new Map();

// ── Cấu hình ──
function cfg() { return settings.getSettings().telegram || {}; }
function saveCfg(patch) {
  const cur = cfg();
  settings.saveSection('telegram', { ...cur, ...patch });
}
function publicStatus() {
  const c = cfg();
  return {
    enabled: !!c.enabled, hasToken: !!c.botToken, userId: c.userId || '', chatId: c.chatId || '',
    running: st.running, botUsername: st.me?.username || null,
    connected: !!(st.running && st.lastOkAt && Date.now() - st.lastOkAt < 90000),
    lastOkAt: st.lastOkAt, lastError: st.lastError, lastErrorAt: st.lastErrorAt, startedAt: st.startedAt,
  };
}
function emitStatus() { bus.emit('telegram', publicStatus()); }

// ── Tiện ích hiển thị ──
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const timeVN = ts => (ts ? new Date(ts).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : '—');
const ago = ts => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? `${s}s trước` : `${Math.floor(s / 60)} phút trước`;
};
const sideVN = s => (s === 'BUY' ? 'MUA' : 'BÁN');
const btn = (text, data) => ({ text, callback_data: data });
const kb = rows => ({ inline_keyboard: rows });
const backMain = () => [btn('🏠 Menu chính', 'm')];

// SL khả dụng tối thiểu — RIÊNG từng sàn, lưu chung (settings.marketFilters) với web
const minQtyFilter = ex => market.getMinQty(ex);
// Limit Min (VND) — bộ lọc RIÊNG của Giá tốt nhất, từng sàn (settings.bestPriceFilters, dùng chung với tool)
const limitMinFilter = ex => market.getLimitMin(ex);
const LIMIT_MIN_OPTIONS = [0, 100000, 500000, 1000000, 5000000];
const limitLabel = v => (v ? `${fmt(v)} VND` : 'Tất cả (không lọc)');
const NO_MATCH = 'Không có quảng cáo phù hợp (No matching advertisements)';

// ── Gửi / sửa tin nhắn ──
async function send(chatId, text, markup) {
  return st.client.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup });
}
async function edit(msg, text, markup) {
  try {
    return await st.client.call('editMessageText', {
      chat_id: msg.chat.id, message_id: msg.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup,
    });
  } catch (err) {
    if (/not modified/i.test(err.message)) return null;
    return send(msg.chat.id, text, markup);   // tin cũ quá hạn sửa → gửi tin mới
  }
}

// ══════════════════════════════════════════════════════════
// MÀN HÌNH
// ══════════════════════════════════════════════════════════
function mainMenu() {
  const s = EXS.map(ex => {
    const e = engine.statusOf(ex);
    const icon = !e.connected ? '⚪' : e.state === 'running' ? '🟢' : e.state === 'error' ? '🔴' : '⏸';
    return `${icon} ${LABEL[ex]}`;
  }).join('   ');
  return {
    text: `<b>P2P MANAGEMENT</b>\n${s}\n\n🟢 đang chạy · ⏸ tạm dừng · 🔴 lỗi · ⚪ chưa kết nối`,
    markup: kb([
      [btn('📋 Quảng cáo của tôi', 'x:my')],
      [btn('⚙️ Quản lý quảng cáo', 'x:mg')],
      [btn('🔎 Market P2P', 'x:mk'), btn('🏆 Giá tốt nhất', 'x:bp')],
      [btn('⏯ Điều khiển Auto Pricing', 'ap')],
      [btn('🔄 Làm mới dữ liệu', 'x:rf')],
    ]),
  };
}

function exchangePicker(fn) {
  const title = { my: '📋 Quảng cáo của tôi', mg: '⚙️ Quản lý quảng cáo', mk: '🔎 Market P2P', bp: '🏆 Giá tốt nhất', rf: '🔄 Làm mới dữ liệu' }[fn];
  const target = { my: 'my', mg: 'mg', mk: 'mk', bp: 'bp', rf: 'rf' }[fn];
  const rows = [];
  const exBtns = EXS.map(ex => btn(`${adapters.get(ex).isConnected() ? '✅' : '⚪'} ${LABEL[ex]}`, `${target}:${ex}${fn === 'my' || fn === 'mg' ? ':0:n' : ''}`));
  rows.push(exBtns.slice(0, 2), exBtns.slice(2, 4));
  if (fn === 'bp' || fn === 'rf') rows.push([btn('🌐 Tất cả sàn', `${target}:all`)]);
  rows.push(backMain());
  return { text: `<b>${title}</b>\nChọn sàn:`, markup: kb(rows) };
}

async function myAdsScreen(ex, page, { manage = false, maxAgeMs = 15000, filter = AF_DEFAULT } = {}) {
  const m = manage ? 'mg' : 'my';
  const title = `<b>${LABEL[ex].toUpperCase()} — ${manage ? 'QUẢN LÝ QUẢNG CÁO' : 'QUẢNG CÁO CỦA TÔI'}</b>`;
  const back = [btn('⬅️ Quay lại', `x:${m}`), ...backMain()];
  if (!adapters.get(ex).isConnected()) return { text: `${title}\n⚪ Chưa kết nối API sàn này trên dashboard.`, markup: kb([back]) };
  const r = await engine.refreshMyAds(ex, { maxAgeMs });
  const all = engine.getMyAds(ex);
  if (!r.ok && !all.length) return { text: `${title}\n❌ Không lấy được quảng cáo: ${esc(r.error)}`, markup: kb([[btn('🔄 Thử lại', `${m}:${ex}:${page}:r`)], back]) };

  const ads = all.filter(ad => matchAdFilter(ex, ad, filter));
  const w = engine.statusOf(ex);
  const lines = [title, '<b>Bộ lọc:</b>', ...filterLines(filter),
    `Số quảng cáo khớp: <b>${ads.length}</b>/${all.length}`,
    `Dữ liệu sàn: ${timeVN(w.myAdsAt)}${r.cached ? ` (cache ${ago(w.myAdsAt)})` : ''}${!r.ok ? ` ⚠️ lần làm mới gần nhất lỗi: ${esc(r.error)}` : ''}`, ''];
  const filterRow = [btn('🔎 Bộ lọc', `af:${ex}:${m}`), btn('♻️ Đặt lại', `afr:${ex}:${m}:l`), btn('🔄 Làm mới', `${m}:${ex}:0:r`)];
  if (!ads.length) {
    lines.push(all.length ? 'Không có quảng cáo phù hợp.' : 'Không có quảng cáo nào trên sàn.');
    return { text: lines.join('\n'), markup: kb([filterRow, back]) };
  }

  const pages = Math.ceil(ads.length / ADS_PER_PAGE);
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = ads.slice(page * ADS_PER_PAGE, page * ADS_PER_PAGE + ADS_PER_PAGE);
  for (const ad of slice) {
    const au = autoEnabled(ex, ad.id);
    lines.push(
      `<b>Quảng cáo #${esc(ad.id)}</b>`,
      `• Loại: ${ad.side === 'BUY' ? 'MUA (BUY)' : 'BÁN (SELL)'}`,
      `• Giá: ${ad.price !== null ? `${fmt(ad.price, 2)} ${esc(ad.fiat)}` : 'thả nổi'}`,
      `• ${ex === 'bingx' ? 'Tổng số lượng' : 'Số lượng'}: ${fmt(ad.available, 4)} ${esc(ad.asset)}`,
      `• Min: ${fmt(ad.min)} ${esc(ad.fiat)}`,
      `• Max: ${fmt(ad.max)} ${esc(ad.fiat)}`,
      `• Trạng thái: ${ad.online ? '🟢 Online' : '🔴 Offline'}`,
      `• Auto Repricing: ${au ? '🟢 Bật' : '🔴 Tắt'}`,
      '',
    );
  }
  lines.push(`Trang ${page + 1}/${pages}`);
  const rows = slice.map(ad => [btn(`⚙️ ${sideVN(ad.side)} #${ad.id.length > 14 ? '…' + ad.id.slice(-10) : ad.id}`, `ad:${ex}:${ad.id}`)]);
  const nav = [];
  if (page > 0) nav.push(btn('◀️ Trước', `${m}:${ex}:${page - 1}`));
  if (page < pages - 1) nav.push(btn('Sau ▶️', `${m}:${ex}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push(filterRow, back);
  return { text: lines.join('\n'), markup: kb(rows) };
}

const PARAM_ORDER = ['quantity', 'ceiling', 'floor', 'tradingQty', 'min', 'max'];
const PARAM_SHORT = { quantity: 'Số lượng QC', ceiling: 'Trần giá', floor: 'Sàn giá', tradingQty: 'SL GD', min: 'Min', max: 'Max' };

async function adScreen(ex, adId, { maxAgeMs = 10000 } = {}) {
  const view = await ops.getAdView(ex, adId, { maxAgeMs });
  const back = [btn('⬅️ Danh sách', `mg:${ex}:0`), ...backMain()];
  if (!view.ok) return { text: `❌ ${esc(view.error)}`, markup: kb([back]) };
  const { ad, values } = view;
  const e = view.engine;
  const engineTxt = !e.running ? '⏸ Tạm dừng' : e.state === 'error' ? `🔴 Lỗi: ${esc(e.error)}` : '▶️ Đang chạy';
  const unit = p => (p === 'quantity' ? ad.asset : ad.fiat);
  const lines = [
    `<b>⚙️ ${LABEL[ex].toUpperCase()} — ${sideVN(ad.side)} #${esc(ad.id)}</b>`,
    `Giá hiện tại: <b>${ad.price !== null ? fmt(ad.price, 2) : 'thả nổi'}</b> ${esc(ad.fiat)}`,
    `Trạng thái QC trên sàn: ${ad.online ? '🟢 Online' : '🔴 Offline'}`,
    `Auto Repricing (QC này): ${values.enabled ? '🟢 Bật' : '🔴 Tắt'} · Auto Pricing (sàn): ${engineTxt}`,
    view.rowStatus ? `Engine gần nhất: ${esc(view.rowStatus.msg)} (${timeVN(view.rowStatus.at)})` : '',
    '',
  ];
  PARAM_ORDER.forEach((p, i) => {
    const cap = ops.supported(ex, p);
    const v = values[p];
    const label = p === 'quantity' && ex === 'bingx' ? 'Tổng số lượng QC' : ops.PARAMS[p].label;
    lines.push(`${i + 1}. ${label}: ${v === null || v === undefined ? '—' : `${fmt(v, p === 'quantity' ? 4 : 2)} ${esc(unit(p))}`}${cap.ok ? '' : ' 🚫'}`);
  });
  lines.push('', '<i>Số lượng QC, Min, Max: cập nhật lên sàn ngay. Trần/Sàn/SL GD: cấu hình engine, tính lại giá ngay.</i>');
  lines.push(`<i>Dữ liệu sàn lúc ${timeVN(e.myAdsAt)}</i>`);
  const pb = p => btn(`${ops.supported(ex, p).ok ? '✏️' : '🚫'} ${PARAM_SHORT[p]}`, `e:${ex}:${ad.id}:${p}`);
  return {
    text: lines.filter(l => l !== '').join('\n').replace('\n1.', '\n\n1.').replace('\n<i>Số', '\n\n<i>Số'),
    markup: kb([
      [pb('quantity'), pb('ceiling'), pb('floor')],
      [pb('tradingQty'), pb('min'), pb('max')],
      [btn(values.enabled ? '⛔ Tắt Auto Repricing QC này' : '✅ Bật Auto Repricing QC này', `e:${ex}:${ad.id}:enabled`)],
      [btn('🔄 Làm mới', `ad:${ex}:${ad.id}:r`), ...back],
    ]),
  };
}

function marketFilterScreen(ex, side) {
  const cur = minQtyFilter(ex);
  const rows = [
    QTY_FILTERS.slice(0, 3).map(q => btn(`${q === cur ? '✔️ ' : ''}${q ? `≥ ${fmt(q)}` : 'Tất cả'}`, `mf:${ex}:${side}:${q}`)),
    QTY_FILTERS.slice(3).map(q => btn(`${q === cur ? '✔️ ' : ''}≥ ${fmt(q)}`, `mf:${ex}:${side}:${q}`)).concat([btn('✍️ Tuỳ chỉnh', `mf:${ex}:${side}:c`)]),
    [btn(`▶️ Xem (bộ lọc hiện tại: ${cur ? '≥ ' + fmt(cur) + ' USDT' : 'tất cả'})`, `ml:${ex}:${side}:0`)],
    [btn('⬅️ Quay lại', `mk:${ex}`), ...backMain()],
  ];
  return {
    text: `<b>🔎 ${LABEL[ex].toUpperCase()} — ADS ${sideVN(side)} CỦA MERCHANT</b>\n\nBộ lọc <b>số lượng khả dụng tối thiểu</b> (USDT).\n<i>Khác với "Số lượng GD" của auto-pricer (số tiền VND dùng để lọc theo giới hạn Min–Max).</i>\nBộ lọc riêng cho ${LABEL[ex]}, giữ nguyên cho đến khi bạn đổi (dùng chung với thẻ Market trên web).\n<i>Giá tốt nhất dùng bộ lọc riêng: Limit Min (VND).</i>`,
    markup: kb(rows),
  };
}

async function marketScreen(ex, side, page, { maxAgeMs = 15000 } = {}) {
  const back = [btn('⚙️ Bộ lọc', `ms:${ex}:${side}`), btn('⬅️ Quay lại', `mk:${ex}`), ...backMain()];
  const minQty = minQtyFilter(ex);
  const r = await market.list(ex, side, { minQty, maxAgeMs, cfgSection: store.section(ex) });
  const head = `<b>🔎 ${LABEL[ex].toUpperCase()} — ADS ${sideVN(side)} (merchant ${side === 'BUY' ? 'mua' : 'bán'} USDT)</b>`;
  if (!r.ok) return { text: `${head}\n❌ ${esc(r.error)}`, markup: kb([[btn('🔄 Thử lại', `mr:${ex}:${side}:0`)], back]) };
  const items = r.items;
  const pages = Math.max(1, Math.ceil(items.length / MARKET_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const lines = [head,
    `Bộ lọc: SL khả dụng ${minQty ? `≥ ${fmt(minQty)} USDT` : 'tất cả'} · bỏ ads của bạn + whitelist${ex === 'bybit' && store.section('bybit').onlineOnly !== false ? ' · chỉ online' : ''}`,
    `Xếp hạng: ${side === 'BUY' ? 'giá cao → thấp' : 'giá thấp → cao'} · ${items.length}/${r.total} ads`,
    `Dữ liệu lúc ${timeVN(r.at)}${r.cached ? ` (cache, ${ago(r.at)})` : ' (vừa lấy)'}`, ''];
  if (!items.length) lines.push('Không có quảng cáo phù hợp.');
  items.slice(page * MARKET_PER_PAGE, (page + 1) * MARKET_PER_PAGE).forEach((m, i) => {
    const n = page * MARKET_PER_PAGE + i + 1;
    lines.push(
      `<b>${n}. ${esc(m.name)}</b> — <b>${fmt(m.price, 2)}</b>`,
      `   SL: ${fmt(m.available, 2)} · ${fmt(m.min)}–${fmt(m.max)}${m.completion !== null ? ` · HT ${(m.completion * 100).toFixed(1)}%` : ''}${m.payments?.length ? `\n   💳 ${esc(m.payments.slice(0, 3).join(', '))}` : ''}`,
    );
  });
  const nav = [];
  if (page > 0) nav.push(btn('◀️', `ml:${ex}:${side}:${page - 1}`));
  nav.push(btn('🔄 Làm mới', `mr:${ex}:${side}:${page}`));
  if (page < pages - 1) nav.push(btn('▶️', `ml:${ex}:${side}:${page + 1}`));
  lines.push('', `Trang ${page + 1}/${pages}`);
  return { text: lines.join('\n'), markup: kb([nav, back]) };
}

async function bestScreen(target, { maxAgeMs = 15000 } = {}) {
  const list = target === 'all' ? EXS : [target];
  const lines = ['<b>🏆 GIÁ P2P TỐT NHẤT — USDT/VND</b>',
    'Mỗi sàn dùng bộ lọc Limit Min (VND) riêng · bỏ ads của bạn + whitelist',
    '<i>Best BUY = giá cao nhất của ads MUA · Best SELL = giá thấp nhất của ads BÁN (cùng quy tắc với engine)</i>', ''];
  let oldest = Date.now(), anyCached = false;
  for (const ex of list) {
    const limitMin = limitMinFilter(ex);
    let b;
    try { b = await market.best(ex, { limitMin, maxAgeMs, cfgSection: store.section(ex) }); } catch (e) { b = { error: e.message, buy: null, sell: null }; }
    lines.push(`<b>${LABEL[ex].toUpperCase()}</b> · Limit Min: ${limitLabel(limitMin)}`);
    if (b.error && b.buy === null && b.sell === null && !b.totalBuy && !b.totalSell) { lines.push(`• ⚠️ ${esc(b.error)}`, ''); continue; }
    const none = NO_MATCH;
    const adInfo = a => (a ? ` (${esc(a.name)}, Limit ${fmt(a.min)}–${fmt(a.max)} VND)` : '');
    lines.push(`• Best BUY: ${b.buy !== null ? `<b>${fmt(b.buy, 2)}</b> VND${adInfo(b.buyAd)}` : none}`);
    lines.push(`• Best SELL: ${b.sell !== null ? `<b>${fmt(b.sell, 2)}</b> VND${adInfo(b.sellAd)}` : none}`);
    lines.push(`• Nguồn: ${esc(b.filters?.depth || '')}${b.filters?.onlineOnly ? ' · chỉ online' : ''}${b.cached ? ` · cache ${ago(b.at)}` : ''}${b.error ? ` · ⚠️ ${esc(b.error)}` : ''}`, '');
    if (b.at) oldest = Math.min(oldest, b.at);
    if (b.cached) anyCached = true;
  }
  lines.push(`Cập nhật: ${timeVN(oldest)}${anyCached ? ' (một phần từ cache — không phải realtime)' : ''}`);
  return { text: lines.join('\n'), markup: kb([[btn('🔄 Làm mới giá', `bpr:${target}`)], [btn('⬅️ Quay lại', target === 'all' ? 'x:bp' : `bp:${target}`), ...backMain()]]) };
}

async function refreshScreen(target) {
  const list = target === 'all' ? EXS : [target];
  const lines = ['<b>🔄 LÀM MỚI DỮ LIỆU</b>', ''];
  for (const ex of list) {
    if (!adapters.get(ex).isConnected()) { lines.push(`⚪ ${LABEL[ex]}: chưa kết nối`); continue; }
    const r = await engine.refreshMyAds(ex);
    const b = await market.best(ex, { maxAgeMs: 3000, cfgSection: store.section(ex) }).catch(e => ({ error: e.message }));
    lines.push(`${r.ok ? '✅' : '❌'} ${LABEL[ex]}: ${r.ok ? `${engine.getMyAds(ex).length} quảng cáo` : esc(r.error)} · market ${b.error ? '⚠️ ' + esc(b.error) : 'OK'}`);
  }
  lines.push('', `Lúc ${timeVN(Date.now())}`);
  return { text: lines.join('\n'), markup: kb([[btn('⬅️ Quay lại', 'x:rf'), ...backMain()]]) };
}

// ══════════════════════════════════════════════════════════
// ★ TRẠNG THÁI — tách bạch 4 loại:
//   Kết nối API (sàn)  ·  Online/Offline (quảng cáo trên sàn)
//   Auto Pricing Running/Stopped (engine của sàn)  ·  Auto Repricing Bật/Tắt (từng quảng cáo)
// ══════════════════════════════════════════════════════════

/** Auto Repricing của 1 quảng cáo — lấy từ cấu hình engine (không suy ra từ Online/Offline) */
function autoEnabled(ex, adId) {
  const sec = store.section(ex);
  if (ex === 'mexc') return !!sec.apConfigs[String(adId)]?.enabled;
  if (ex === 'bingx') return !!sec.configs[String(adId)]?.enabled;
  return sec.rows.some(r => String(r.advId) === String(adId) && r.enabled);
}
const engineLabel = st => (!st.running ? '🔴 Stopped' : st.state === 'error' ? '⚠️ Error (đang thử lại)' : '🟢 Running');

// ══════════════════════════════════════════════════════════
// ★ BỘ LỌC "QUẢNG CÁO CỦA TÔI" (Trạng thái × Loại × Auto Repricing)
//   Chưa chọn = Tất cả. Bộ lọc là trạng thái tạm của giao diện Telegram (theo chat + sàn).
// ══════════════════════════════════════════════════════════
const AF_DEFAULT = { st: 'all', sd: 'all', au: 'all' };
const AF_LABEL = {
  st: { all: 'Tất cả', on: 'Online', off: 'Offline' },
  sd: { all: 'Tất cả', BUY: 'MUA', SELL: 'BÁN' },
  au: { all: 'Tất cả', on: 'Bật', off: 'Tắt' },
};
function adFilterOf(sess, ex) { sess.adFilter = sess.adFilter || {}; return sess.adFilter[ex] || { ...AF_DEFAULT }; }
function setAdFilter(sess, ex, f) { sess.adFilter = sess.adFilter || {}; sess.adFilter[ex] = { ...f }; }
function matchAdFilter(ex, ad, f) {
  if (f.st === 'on' && !ad.online) return false;
  if (f.st === 'off' && ad.online) return false;
  if (f.sd !== 'all' && ad.side !== f.sd) return false;
  if (f.au !== 'all') {
    const on = autoEnabled(ex, ad.id);
    if (f.au === 'on' && !on) return false;
    if (f.au === 'off' && on) return false;
  }
  return true;
}
const filterLines = f => [
  `• Trạng thái QC: <b>${AF_LABEL.st[f.st]}</b>`,
  `• Loại: <b>${AF_LABEL.sd[f.sd]}</b>`,
  `• Auto Repricing: <b>${AF_LABEL.au[f.au]}</b>`,
];

function adFilterScreen(ex, m, draft) {
  const mark = (dim, v) => (draft[dim] === v ? '✔️ ' : '');
  const row = (dim, vals) => vals.map(v => btn(`${mark(dim, v)}${AF_LABEL[dim][v]}`, `afs:${ex}:${m}:${dim}:${v}`));
  return {
    text: [`<b>🔎 ${LABEL[ex].toUpperCase()} — BỘ LỌC QUẢNG CÁO</b>`, ...filterLines(draft), '',
      '<i>Chưa chọn = Tất cả. Các bộ lọc được kết hợp với nhau (VÀ).</i>',
      '<i>Online/Offline lấy từ sàn; Auto Repricing lấy từ cấu hình của tool — là 2 trạng thái khác nhau.</i>'].join('\n'),
    markup: kb([
      [btn('— Trạng thái QC —', 'noop')], row('st', ['all', 'on', 'off']),
      [btn('— Loại —', 'noop')], row('sd', ['all', 'BUY', 'SELL']),
      [btn('— Auto Repricing —', 'noop')], row('au', ['all', 'on', 'off']),
      [btn('✅ Áp dụng', `afa:${ex}:${m}`), btn('♻️ Đặt lại', `afr:${ex}:${m}`)],
      [btn('🔄 Làm mới QC', `afa:${ex}:${m}:r`), btn('⬅️ Quay lại', `${m}:${ex}:0`)],
    ]),
  };
}

// ══════════════════════════════════════════════════════════
// ★ GIÁ TỐT NHẤT — bộ lọc Limit Min (VND) RIÊNG từng sàn
//   Điều kiện: ad.min ≤ Limit Min ≤ ad.max (số tiền nằm trong khoảng giới hạn giao dịch của ad).
//   Chỉ dùng để chọn ads tính Giá tốt nhất — KHÔNG sửa Min/Max quảng cáo trên sàn.
// ══════════════════════════════════════════════════════════
function bpSettingsScreen(ex) {
  const v = limitMinFilter(ex);
  return {
    text: [`<b>🏆 ${LABEL[ex].toUpperCase()} — CÀI ĐẶT GIÁ TỐT NHẤT</b>`, '',
      `Limit Min: <b>${limitLabel(v)}</b>`, '',
      '<i>Chỉ tính các quảng cáo có Limit Min ≤ số tiền này ≤ Limit Max (giao dịch được với số tiền đó).</i>',
      '<i>Bộ lọc riêng cho sàn này, áp dụng cho cả Best BUY và Best SELL (dùng chung với tool).</i>',
      '<i>Không thay đổi Min/Max quảng cáo trên sàn và bộ lọc của auto-pricer.</i>'].join('\n'),
    markup: kb([
      [btn('✏️ Sửa Limit Min', `bq:${ex}`)],
      [btn('🟢 Giá MUA tốt nhất', `bs:${ex}:BUY`), btn('🔴 Giá BÁN tốt nhất', `bs:${ex}:SELL`)],
      [btn('📊 Cả hai', `bs:${ex}:ALL`)],
      [btn('♻️ Reset bộ lọc (tất cả)', `bqs:${ex}:0`)],
      [btn('⬅️ Quay lại', 'x:bp'), ...backMain()],
    ]),
  };
}

function bpQtyScreen(ex) {
  const cur = limitMinFilter(ex);
  const opt = v => btn(`${v === cur ? '✔️ ' : ''}${v ? fmt(v) : 'Tất cả (không lọc)'}`, `bqs:${ex}:${v}`);
  const [o0, o1, o2, o3, o4] = LIMIT_MIN_OPTIONS;
  const custom = cur && !LIMIT_MIN_OPTIONS.includes(cur);
  return {
    text: `<b>✏️ ${LABEL[ex].toUpperCase()} — LIMIT MIN (VND)</b>\nHiện tại: <b>${limitLabel(cur)}</b>\n\n`
      + 'Chỉ quảng cáo có Limit Min ≤ số tiền này ≤ Limit Max mới được dùng để tính giá tốt nhất.\n'
      + '<i>Vd chọn 1,000,000: ad 100,000–50,000,000 và 1,000,000–3,000,000 được giữ; ad 2,000,000–60,000,000 hoặc 100,000–500,000 bị loại.</i>',
    markup: kb([
      [opt(o0)],
      [opt(o1), opt(o2)],
      [opt(o3), opt(o4)],
      [btn(`${custom ? '✔️ ' : ''}✍️ Tuỳ chỉnh Limit Min (VND)`, `bqs:${ex}:c`)],
      [btn('⬅️ Quay lại', `bp:${ex}`), ...backMain()],
    ]),
  };
}

function marketAdLine(n, m, { limitFirst = false } = {}) {
  const lim = `Limit ${fmt(m.min)}–${fmt(m.max)} VND`;
  const qty = `SL ${fmt(m.available, 2)} USDT`;
  return `${n}. <b>${esc(m.name)}</b> — <b>${fmt(m.price, 2)}</b> · ${limitFirst ? `${lim} · ${qty}` : `${qty} · ${lim}`}`
    + `${m.completion !== null && m.completion !== undefined ? ` · HT ${(m.completion * 100).toFixed(1)}%` : ''}`
    + `${m.payments?.length ? `\n    💳 ${esc(m.payments.slice(0, 3).join(', '))}` : ''}`;
}

async function bestDetailScreen(ex, side, { maxAgeMs = 15000 } = {}) {
  const lm = limitMinFilter(ex);
  const sec = store.section(ex);
  const back = [btn('⬅️ Quay lại', `bp:${ex}`), ...backMain()];
  let b;
  try { b = await market.best(ex, { limitMin: lm, maxAgeMs, cfgSection: sec }); } catch (e) { b = { error: e.message, buy: null, sell: null }; }
  const lines = [`<b>🏆 ${LABEL[ex].toUpperCase()} — GIÁ TỐT NHẤT (USDT/VND)</b>`,
    `Bộ lọc: Limit Min: <b>${limitLabel(lm)}</b> · bỏ ads của bạn + whitelist${b.filters?.onlineOnly ? ' · chỉ online' : ''}`,
    '<i>Best BUY = giá cao nhất của ads MUA · Best SELL = giá thấp nhất của ads BÁN (cùng quy tắc engine)</i>', ''];
  if (b.error && b.buy === null && b.sell === null && !b.buyTop && !b.sellTop) {
    lines.push(`⚠️ ${esc(b.error)}`);
  } else {
    for (const sd of side === 'ALL' ? ['BUY', 'SELL'] : [side]) {
      const top = sd === 'BUY' ? (b.buyTop || []) : (b.sellTop || []);
      const total = sd === 'BUY' ? b.totalBuy : b.totalSell;
      lines.push(sd === 'BUY' ? '<b>🟢 Best BUY</b>' : '<b>🔴 Best SELL</b>');
      if (!top.length) lines.push(`${NO_MATCH}${total ? ` — ${total} ads bị loại bởi bộ lọc` : ''}.`);
      else {
        lines.push(`Giá: <b>${fmt(top[0].price, 2)} VND</b>`);
        top.forEach((m, i) => lines.push(marketAdLine(i + 1, m, { limitFirst: true })));
      }
      lines.push('');
    }
    if (b.error) lines.push(`⚠️ ${esc(b.error)}`);
    lines.push(`Cập nhật: ${timeVN(b.at)}${b.cached ? ` (cache ${ago(b.at)} — không phải realtime)` : ' (vừa lấy)'}`);
  }
  return {
    text: lines.join('\n'),
    markup: kb([[btn('🔄 Làm mới giá', `bsr:${ex}:${side}`), btn('✏️ Limit Min', `bq:${ex}`)], back]),
  };
}

// ══════════════════════════════════════════════════════════
// ★ ĐIỀU KHIỂN AUTO PRICING (sàn / từng quảng cáo / tất cả)
//   Điều khiển đúng engine hiện có — không tạo tiến trình chỉnh giá riêng
// ══════════════════════════════════════════════════════════
function apStatusScreen() {
  const lines = ['<b>⏯ AUTO PRICING — TRẠNG THÁI</b>', ''];
  for (const ex of EXS) {
    const st = engine.statusOf(ex);
    lines.push(`<b>${LABEL[ex]}</b>: ${engineLabel(st)}${st.connected ? '' : ' · ⚪ chưa kết nối API'} · ${st.enabledCount} QC bật Auto Repricing`);
  }
  lines.push('', `<i>Auto Pricing (sàn) ≠ Auto Repricing (từng quảng cáo) ≠ Online/Offline (trạng thái QC trên sàn).</i>`, `Lúc ${timeVN(Date.now())}`);
  const exBtns = EXS.map(ex => btn(LABEL[ex], `ape:${ex}`));
  return {
    text: lines.join('\n'),
    markup: kb([exBtns.slice(0, 2), exBtns.slice(2, 4),
      [btn('✅ Bật tất cả', 'apall:on'), btn('⛔ Tắt tất cả', 'apall:off')],
      [btn('🔄 Làm mới', 'ap'), ...backMain()]]),
  };
}

function apExScreen(ex) {
  const st = engine.statusOf(ex);
  const v = engine.validateConfig(ex);
  const lines = [`<b>⏯ ${LABEL[ex].toUpperCase()} — AUTO PRICING</b>`, '',
    `Trạng thái: <b>${engineLabel(st)}</b>`,
    st.error ? `Lỗi gần nhất: ${esc(st.error)}` : '',
    `Kết nối API: ${st.connected ? '🟢 Đã kết nối' : '⚪ Chưa kết nối'}${ex === 'mexc' && st.connected && !st.market?.ok ? ' (thiếu API phụ để lấy market)' : ''}`,
    `QC bật Auto Repricing: <b>${st.enabledCount}</b>`,
    `Chu kỳ quét: ${st.interval}s · Lần quét cuối: ${timeVN(st.lastCycleAt)}`,
    `Lần đổi giá cuối: ${timeVN(st.lastPriceUpdateAt)} (${st.updates} lần từ khi khởi động app)`];
  if (!st.running && (v.errors.length || v.warnings.length)) {
    lines.push('', '<b>Kiểm tra trước khi bật:</b>');
    v.errors.forEach(e => lines.push(`❌ ${esc(e)}`));
    v.warnings.forEach(w => lines.push(`⚠️ ${esc(w)}`));
  }
  return {
    text: lines.filter(Boolean).join('\n'),
    markup: kb([
      [btn(`${st.running ? '▶️ ' : ''}✅ Bật Auto Pricing`, `apx:${ex}:on`), btn(`${st.running ? '' : '⏸ '}⛔ Tắt Auto Pricing`, `apx:${ex}:off`)],
      [btn('📋 Bật/tắt từng quảng cáo', `apa:${ex}:0`)],
      [btn('🔄 Làm mới', `ape:${ex}`), btn('⬅️ Quay lại', 'ap'), ...backMain()],
    ]),
  };
}

async function apAdsScreen(ex, page, { maxAgeMs = 15000 } = {}) {
  const back = [btn('⬅️ Quay lại', `ape:${ex}`), ...backMain()];
  if (!adapters.get(ex).isConnected()) return { text: `<b>${LABEL[ex].toUpperCase()}</b>\n⚪ Chưa kết nối sàn này trên dashboard.`, markup: kb([back]) };
  const r = await engine.refreshMyAds(ex, { maxAgeMs });
  const ads = engine.getMyAds(ex);
  if (!ads.length) return { text: `<b>${LABEL[ex].toUpperCase()} — AUTO REPRICING TỪNG QC</b>\n${r.ok ? 'Không có quảng cáo nào.' : `❌ ${esc(r.error)}`}`, markup: kb([back]) };
  const per = 6, pages = Math.ceil(ads.length / per);
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = ads.slice(page * per, page * per + per);
  const st = engine.statusOf(ex);
  const lines = [`<b>${LABEL[ex].toUpperCase()} — AUTO REPRICING TỪNG QUẢNG CÁO</b>`,
    `Auto Pricing của sàn: ${engineLabel(st)}`, ''];
  slice.forEach((ad, i) => lines.push(`${page * per + i + 1}. ${sideVN(ad.side)} #${esc(ad.id)} — ${ad.online ? '🟢 Online' : '🔴 Offline'} · Auto Repricing ${autoEnabled(ex, ad.id) ? '🟢 Bật' : '🔴 Tắt'}`));
  lines.push('', `Trang ${page + 1}/${pages} · Bấm để bật/tắt (có xác nhận). Chỉ ảnh hưởng đúng quảng cáo đó.`);
  const rows = slice.map(ad => {
    const on = autoEnabled(ex, ad.id);
    return [btn(`${on ? '⛔ Tắt' : '✅ Bật'} · ${sideVN(ad.side)} #${ad.id.length > 14 ? '…' + ad.id.slice(-10) : ad.id}`, `apt:${ex}:${ad.id}`)];
  });
  const nav = [];
  if (page > 0) nav.push(btn('◀️', `apa:${ex}:${page - 1}`));
  nav.push(btn('🔄', `apa:${ex}:${page}:r`));
  if (page < pages - 1) nav.push(btn('▶️', `apa:${ex}:${page + 1}`));
  rows.push(nav, back);
  return { text: lines.join('\n'), markup: kb(rows) };
}

async function askEngineConfirm(chatId, target, on) {
  const token = crypto.randomBytes(6).toString('hex');
  pending.set(token, { kind: 'engine', chatId, target, on, at: Date.now() });
  const list = target === 'all' ? EXS : [target];
  const lines = ['<b>Xác nhận</b>'];
  if (target === 'all') lines.push(`Bạn chắc chắn muốn <b>${on ? 'BẬT' : 'TẮT'}</b> Auto Pricing cho cả 4 sàn?`);
  else lines.push(`${on ? 'BẬT' : 'TẮT'} Auto Pricing cho <b>${LABEL[target]}</b>?`);
  lines.push('');
  for (const ex of list) {
    const st = engine.statusOf(ex);
    if (on) {
      if (st.running) { lines.push(`⏭ ${LABEL[ex]}: đang chạy sẵn`); continue; }
      const v = engine.validateConfig(ex);
      lines.push(`${v.ok ? '•' : '❌'} ${LABEL[ex]}: ${v.ok ? `${v.enabled} QC bật Auto Repricing` : esc(v.errors.join('; '))}`);
      v.warnings.forEach(w => lines.push(`   ⚠️ ${esc(w)}`));
    } else {
      lines.push(st.running ? `• ${LABEL[ex]}: sẽ dừng` : `⏭ ${LABEL[ex]}: đã dừng sẵn`);
    }
  }
  if (!on) lines.push('', '<i>Giữ nguyên toàn bộ cấu hình · không xóa quảng cáo · không đổi Online/Offline.</i>');
  return send(chatId, lines.join('\n'), kb([[btn('✅ Xác nhận', `ok:${token}`), btn('❌ Hủy', `no:${token}`)]]));
}

/** Thực hiện bật/tắt và báo KẾT QUẢ THỰC TẾ từng sàn (kể cả thất bại một phần) */
async function runEngineConfirm(msg, op) {
  const list = op.target === 'all' ? EXS : [op.target];
  await edit(msg, '⏳ Đang thực hiện...');
  const lines = [`<b>${op.on ? 'BẬT' : 'TẮT'} AUTO PRICING — KẾT QUẢ</b>`, ''];
  let okN = 0, failN = 0, skipN = 0;
  for (const ex of list) {
    const before = engine.statusOf(ex);
    if (op.on) {
      if (before.running) { skipN++; lines.push(`⏭ ${LABEL[ex]}: đang chạy sẵn — giữ nguyên`); continue; }
      const v = engine.validateConfig(ex);
      if (!v.ok) {
        failN++; lines.push(`❌ ${LABEL[ex]}: không bật được — ${esc(v.errors.join('; '))}`);
        audit.record({ exchange: ex, parameter: 'autoPricer', previous: 'stopped', next: 'start', source: 'telegram', status: 'failed', message: v.errors.join('; ') });
        continue;
      }
      const r = engine.start(ex, { source: 'telegram' });
      const after = engine.statusOf(ex);
      if (r.ok && after.running) {
        okN++; lines.push(`✅ ${LABEL[ex]}: 🟢 Running · ${after.enabledCount} QC bật Auto Repricing${v.warnings.length ? `\n   ⚠️ ${esc(v.warnings.join('\n   ⚠️ '))}` : ''}`);
        audit.record({ exchange: ex, parameter: 'autoPricer', previous: 'stopped', next: 'start', source: 'telegram', status: 'success' });
      } else {
        failN++; lines.push(`❌ ${LABEL[ex]}: không bật được — ${esc(r.msg || 'trạng thái không đổi')}`);
        audit.record({ exchange: ex, parameter: 'autoPricer', previous: 'stopped', next: 'start', source: 'telegram', status: 'failed', message: r.msg });
      }
    } else {
      if (!before.running) { skipN++; lines.push(`⏭ ${LABEL[ex]}: đã dừng sẵn`); continue; }
      const r = engine.stop(ex, { source: 'telegram' });
      const after = engine.statusOf(ex);
      if (!after.running) {
        okN++; lines.push(`✅ ${LABEL[ex]}: 🔴 Stopped${r.inFlight ? ' (yêu cầu đang gửi dở sẽ hoàn tất, không gửi thêm)' : ''}`);
        audit.record({ exchange: ex, parameter: 'autoPricer', previous: 'running', next: 'stop', source: 'telegram', status: 'success' });
      } else {
        failN++; lines.push(`❌ ${LABEL[ex]}: không dừng được`);
        audit.record({ exchange: ex, parameter: 'autoPricer', previous: 'running', next: 'stop', source: 'telegram', status: 'failed' });
      }
    }
  }
  lines.push('', `Thành công: ${okN} · Thất bại: ${failN} · Bỏ qua: ${skipN}`, 'Dashboard web đã được đồng bộ.');
  const backBtn = op.target === 'all' ? btn('⬅️ Trạng thái', 'ap') : btn(`⬅️ ${LABEL[op.target]}`, `ape:${op.target}`);
  return edit(msg, lines.join('\n'), kb([[backBtn, ...backMain()]]));
}

// ══════════════════════════════════════════════════════════
// SỬA THAM SỐ: nhập giá trị → xác nhận → áp dụng
// ══════════════════════════════════════════════════════════
async function startEdit(msg, ex, adId, param) {
  const chatId = msg.chat.id;
  const view = await ops.getAdView(ex, adId, { maxAgeMs: 5000 });
  if (!view.ok) return edit(msg, `❌ ${esc(view.error)}`, kb([[btn('⬅️ Danh sách', `mg:${ex}:0`), ...backMain()]]));
  const cap = ops.supported(ex, param);
  if (!cap.ok) {
    return send(chatId, `🚫 ${LABEL[ex]} không hỗ trợ sửa <b>${esc(ops.PARAMS[param].label)}</b> qua API hiện có.${cap.note ? `\n${esc(cap.note)}` : ''}`, kb([[btn('⬅️ Về quảng cáo', `ad:${ex}:${adId}`)]]));
  }
  if (param === 'enabled') return askConfirm(chatId, view, param, !view.values.enabled);

  const cur = view.values[param];
  const unit = param === 'quantity' ? view.ad.asset : view.ad.fiat;
  const clearable = ['ceiling', 'floor', 'tradingQty'].includes(param);
  sessions.set(chatId, { ...(sessions.get(chatId) || {}), awaiting: { type: 'param', ex, adId, param, v: view.v, at: Date.now() } });
  const hint = {
    quantity: ex === 'bingx' ? 'Tổng số lượng (totalNumber) của quảng cáo.' : 'Số lượng coin của quảng cáo.',
    ceiling: 'Engine không bao giờ đặt giá cao hơn trần.',
    floor: 'Engine không bao giờ đặt giá thấp hơn sàn.',
    tradingQty: 'Số tiền VND dùng để lọc ads đối thủ (phải nằm trong Min–Max của họ). Không phải số lượng quảng cáo.',
    min: 'Giới hạn giao dịch tối thiểu mỗi lệnh — cập nhật lên sàn ngay.',
    max: 'Giới hạn giao dịch tối đa mỗi lệnh — cập nhật lên sàn ngay.',
  }[param];
  return send(chatId,
    `✏️ <b>${esc(ops.PARAMS[param].label)}</b> — ${LABEL[ex]} ${sideVN(view.ad.side)} #${esc(adId)}\n` +
    `Hiện tại: <b>${cur === null || cur === undefined ? '—' : fmt(cur, 4)} ${esc(unit)}</b>\n<i>${esc(hint)}</i>\n\n` +
    `Gõ giá trị mới (vd: 26100 hoặc 26,100)${clearable ? ', hoặc gõ <code>xoa</code> để bỏ giới hạn' : ''}.`,
    kb([[btn('❌ Hủy', 'cx')]]));
}

async function askConfirm(chatId, view, param, value, warnings = [], { back = null } = {}) {
  const token = crypto.randomBytes(6).toString('hex');
  pending.set(token, { chatId, ex: view.ex, adId: view.ad.id, param, value, expectV: view.key !== null ? view.v : null, at: Date.now(), back });
  const unit = param === 'quantity' ? view.ad.asset : view.ad.fiat;
  const show = v => (param === 'enabled' ? (v ? '✅ Bật' : '⛔ Tắt') : v === null || v === undefined ? '— (không giới hạn)' : `${fmt(v, 4)} ${unit}`);
  const where = { quantity: 'Gửi lên sàn ngay', min: 'Gửi lên sàn ngay', max: 'Gửi lên sàn ngay' }[param] || 'Lưu cấu hình engine + tính lại giá';
  return send(chatId,
    `<b>Xác nhận thay đổi</b>\nSàn: ${LABEL[view.ex]}\nQuảng cáo: ${sideVN(view.ad.side)} #${esc(view.ad.id)}\nTham số: ${esc(ops.PARAMS[param].label)}\n\n` +
    `Cũ: <b>${esc(show(view.values[param]))}</b>\nMới: <b>${esc(show(value))}</b>\n\n<i>${where}</i>` +
    (warnings.length ? `\n\n⚠️ ${warnings.map(esc).join('\n⚠️ ')}` : ''),
    kb([[btn('✅ Xác nhận', `ok:${token}`), btn('❌ Hủy', `no:${token}`)]]));
}

async function onParamInput(chatId, text, aw) {
  const view = await ops.getAdView(aw.ex, aw.adId, { maxAgeMs: 5000 });
  if (!view.ok) { sessions.get(chatId).awaiting = null; return send(chatId, `❌ ${esc(view.error)}`, kb([backMain()])); }
  const clearable = ['ceiling', 'floor', 'tradingQty'].includes(aw.param);
  let value;
  if (clearable && /^(xoa|xóa|-|none|clear)$/i.test(text.trim())) value = null;
  else {
    value = parseUserNumber(text);
    if (value === null) return send(chatId, '⚠️ Giá trị không hợp lệ — hãy gõ một số (vd 26100). Thử lại hoặc bấm Hủy.', kb([[btn('❌ Hủy', 'cx')]]));
  }
  const chk = ops.validate(view, aw.param, value);
  if (!chk.ok) return send(chatId, `⚠️ ${esc(chk.error)}\nNhập lại hoặc bấm Hủy.`, kb([[btn('❌ Hủy', 'cx')]]));
  sessions.get(chatId).awaiting = null;
  if (view.v !== aw.v && view.key !== null) {
    return send(chatId, '⚠️ Cấu hình quảng cáo vừa được đổi ở nơi khác. Mở lại quảng cáo để xem giá trị mới nhất.', kb([[btn('⬅️ Về quảng cáo', `ad:${aw.ex}:${aw.adId}`)]]));
  }
  return askConfirm(chatId, view, aw.param, chk.value, chk.warnings);
}

async function onConfirm(msg, token) {
  const op = pending.get(token);
  pending.delete(token);   // dùng 1 lần — bấm lại sẽ không áp dụng lần 2
  if (!op || op.chatId !== msg.chat.id) return edit(msg, '⌛ Thao tác này đã được xử lý hoặc đã hết hạn.', kb([backMain()]));
  if (Date.now() - op.at > PENDING_TTL) return edit(msg, '⌛ Xác nhận đã hết hạn (5 phút). Hãy thực hiện lại.', kb([op.kind === 'engine' ? [btn('⬅️ Auto Pricing', 'ap')] : [btn('⬅️ Về quảng cáo', `ad:${op.ex}:${op.adId}`)]]));
  if (op.kind === 'engine') return runEngineConfirm(msg, op);
  await edit(msg, '⏳ Đang áp dụng... (chờ sàn xác nhận nếu cần)');
  const r = await ops.apply(op.ex, op.adId, op.param, op.value, { source: 'telegram', expectV: op.expectV });
  const label = ops.PARAMS[op.param].label;
  const lines = [];
  if (r.ok) {
    lines.push(`✅ <b>Đã cập nhật ${esc(label)}</b>`, `${LABEL[op.ex]} #${esc(op.adId)}`);
    if (r.exchangeStatus) lines.push(`Sàn xác nhận: ${esc(r.exchangeStatus)}`);
    if (r.recalc) {
      const rc = r.recalc;
      if (rc.error) lines.push(`⚠️ Tính lại giá lỗi: ${esc(rc.error)}`);
      else if (rc.applied) lines.push(`💱 Giá mới đã đặt trên sàn: <b>${fmt(rc.target, 2)}</b> (cũ ${fmt(rc.current, 2)})`);
      else if (rc.target !== null) lines.push(`🎯 Giá mục tiêu: <b>${fmt(rc.target, 2)}</b> (hiện tại ${fmt(rc.current, 2)})${rc.note ? `\nℹ️ ${esc(rc.note)}` : (rc.target === rc.current ? ' — không cần đổi' : '')}`);
      else if (rc.status) lines.push(`ℹ️ Engine: ${esc(rc.status)}${rc.note ? ` · ${esc(rc.note)}` : ''}`);
      else if (rc.note) lines.push(`ℹ️ ${esc(rc.note)}`);
    }
    if (r.warnings?.length) lines.push(`⚠️ ${r.warnings.map(esc).join('\n⚠️ ')}`);
    lines.push('', 'Dashboard web đã được đồng bộ.');
  } else {
    lines.push(`❌ <b>Không thành công — ${esc(label)}</b>`, esc(r.msg), '', 'Giá trị KHÔNG bị thay đổi.');
  }
  const backRow = op.back === 'apa'
    ? [btn('⬅️ Danh sách QC', `apa:${op.ex}:0:r`), btn('⬅️ Về quảng cáo', `ad:${op.ex}:${op.adId}:r`)]
    : [btn('⬅️ Về quảng cáo', `ad:${op.ex}:${op.adId}:r`)];
  return edit(msg, lines.join('\n'), kb([[...backRow, ...backMain()]]));
}

// ══════════════════════════════════════════════════════════
// XỬ LÝ UPDATE
// ══════════════════════════════════════════════════════════
function authorized(from, chat) {
  const c = cfg();
  return c.userId && c.chatId && String(from?.id) === String(c.userId).trim() && String(chat?.id) === String(c.chatId).trim();
}

async function deny(chat, from) {
  logger.warn(`[Telegram] Từ chối truy cập: user=${from?.id} chat=${chat?.id}`);
  const last = deniedAt.get(chat?.id) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  deniedAt.set(chat?.id, Date.now());
  try { await send(chat.id, '⛔ Bạn không có quyền sử dụng bot này.'); } catch (_) {}
}

async function onMessage(m) {
  if (!m.text) return;
  if (!authorized(m.from, m.chat)) return deny(m.chat, m.from);
  const chatId = m.chat.id;
  const text = m.text.trim();
  const sess = sessions.get(chatId) || {};
  sessions.set(chatId, sess);

  if (/^\/(start|menu|help)/i.test(text)) { sess.awaiting = null; const s = mainMenu(); return send(chatId, s.text, s.markup); }
  if (/^\/cancel/i.test(text)) { sess.awaiting = null; return send(chatId, '❎ Đã hủy thao tác đang chờ.', kb([backMain()])); }

  const aw = sess.awaiting;
  if (aw && Date.now() - aw.at > PENDING_TTL) sess.awaiting = null;
  if (sess.awaiting?.type === 'param') return onParamInput(chatId, text, sess.awaiting);
  if (sess.awaiting?.type === 'minQty') {
    const v = parseUserNumber(text);
    if (v === null || v < 0) return send(chatId, '⚠️ Hãy gõ số USDT (vd 2000) hoặc bấm Hủy.', kb([[btn('❌ Hủy', 'cx')]]));
    const { ex, side } = sess.awaiting;
    sess.awaiting = null;
    market.setMinQty(ex, v, { source: 'telegram' });
    const s = await marketScreen(ex, side, 0);
    return send(chatId, s.text, s.markup);
  }
  if (sess.awaiting?.type === 'bestLimitMin') {
    const v = parseUserNumber(text);
    if (v === null || v < 0) return send(chatId, '⚠️ Hãy gõ số tiền VND ≥ 0 (vd 1,000,000 · 2tr · 500k) hoặc bấm Hủy.', kb([[btn('❌ Hủy', 'cx')]]));
    const { ex } = sess.awaiting;
    sess.awaiting = null;
    market.setLimitMin(ex, Math.round(v), { source: 'telegram' });
    const s = bpSettingsScreen(ex);
    return send(chatId, `✅ Đã đặt Limit Min cho ${LABEL[ex]}: ${limitLabel(Math.round(v))}

${s.text}`, s.markup);
  }
  const s = mainMenu();
  return send(chatId, s.text, s.markup);
}

async function onCallback(q) {
  const msg = q.message;
  if (seenCallbacks.has(q.id)) return;   // callback lặp lại (Telegram gửi lại) → bỏ qua
  seenCallbacks.add(q.id);
  if (seenCallbacks.size > 2000) seenCallbacks.delete(seenCallbacks.values().next().value);
  if (!msg || !authorized(q.from, msg.chat)) {
    try { await st.client.call('answerCallbackQuery', { callback_query_id: q.id, text: '⛔ Không có quyền', show_alert: true }); } catch (_) {}
    return deny(msg?.chat || { id: q.from?.id }, q.from);
  }
  try { await st.client.call('answerCallbackQuery', { callback_query_id: q.id }); } catch (_) {}

  const chatId = msg.chat.id;
  const sess = sessions.get(chatId) || {};
  sessions.set(chatId, sess);
  const parts = String(q.data || '').split(':');
  const [cmd, a1, a2, a3, a4] = parts;
  const show = s => edit(msg, s.text, s.markup);

  switch (cmd) {
    case 'm': sess.awaiting = null; return show(mainMenu());
    case 'cx': sess.awaiting = null; return edit(msg, '❎ Đã hủy.', kb([backMain()]));
    case 'x': return show(exchangePicker(a1));
    case 'noop': return;
    case 'my':
    case 'mg':
      if (a3 === 'n') setAdFilter(sess, a1, AF_DEFAULT);   // mở danh sách từ menu chọn sàn → không lọc gì (= Tất cả)
      return show(await myAdsScreen(a1, Number(a2) || 0, { manage: cmd === 'mg', maxAgeMs: a3 === 'r' ? 0 : 15000, filter: adFilterOf(sess, a1) }));
    // Bộ lọc quảng cáo: af = mở, afs = chọn giá trị (nháp), afa = áp dụng, afr = đặt lại
    case 'af':
      sess.adFilterDraft = { ...(sess.adFilterDraft || {}), [a1]: { ...adFilterOf(sess, a1) } };
      return show(adFilterScreen(a1, a2, sess.adFilterDraft[a1]));
    case 'afs': {
      const d = { ...((sess.adFilterDraft || {})[a1] || adFilterOf(sess, a1)) };
      if (AF_LABEL[a3] && a4 in AF_LABEL[a3]) d[a3] = a4;
      sess.adFilterDraft = { ...(sess.adFilterDraft || {}), [a1]: d };
      return show(adFilterScreen(a1, a2, d));
    }
    case 'afa': {
      const d = (sess.adFilterDraft || {})[a1] || adFilterOf(sess, a1);
      setAdFilter(sess, a1, d);
      return show(await myAdsScreen(a1, 0, { manage: a2 === 'mg', maxAgeMs: a3 === 'r' ? 0 : 15000, filter: d }));
    }
    case 'afr':
      setAdFilter(sess, a1, AF_DEFAULT);
      sess.adFilterDraft = { ...(sess.adFilterDraft || {}), [a1]: { ...AF_DEFAULT } };
      return show(a3 === 'l' ? await myAdsScreen(a1, 0, { manage: a2 === 'mg', filter: AF_DEFAULT }) : adFilterScreen(a1, a2, AF_DEFAULT));
    // Điều khiển Auto Pricing
    case 'ap': return show(apStatusScreen());
    case 'ape': return show(apExScreen(a1));
    case 'apx': return askEngineConfirm(chatId, a1, a2 === 'on');
    case 'apall': return askEngineConfirm(chatId, 'all', a1 === 'on');
    case 'apa': return show(await apAdsScreen(a1, Number(a2) || 0, { maxAgeMs: a3 === 'r' ? 0 : 15000 }));
    case 'apt': {
      const view = await ops.getAdView(a1, a2, { maxAgeMs: 5000 });
      if (!view.ok) return show({ text: `❌ ${esc(view.error)}`, markup: kb([[btn('⬅️ Quay lại', `apa:${a1}:0:r`), ...backMain()]]) });
      const warns = [];
      if (view.key === null) warns.push('Quảng cáo chưa có cấu hình auto-pricer — sẽ dùng cấu hình mặc định (xem/chỉnh trên dashboard)');
      if (!view.values.enabled && !engine.statusOf(a1).running) warns.push(`Auto Pricing của ${LABEL[a1]} đang tắt — QC chỉ được chỉnh giá khi bật Auto Pricing cho sàn`);
      return askConfirm(chatId, view, 'enabled', !view.values.enabled, warns, { back: 'apa' });
    }
    case 'ad': return show(await adScreen(a1, a2, { maxAgeMs: a3 === 'r' ? 0 : 10000 }));
    case 'e': return startEdit(msg, a1, a2, a3);
    case 'ok': return onConfirm(msg, a1);
    case 'no': {
      const op = pending.get(a1); pending.delete(a1);
      const backRow = !op ? backMain()
        : op.kind === 'engine' ? [btn('⬅️ Auto Pricing', op.target === 'all' ? 'ap' : `ape:${op.target}`), ...backMain()]
        : [btn('⬅️ Về quảng cáo', `ad:${op.ex}:${op.adId}`), ...backMain()];
      return edit(msg, '❎ Đã hủy — không có thay đổi nào.', kb([backRow]));
    }
    case 'mk': return show({
      text: `<b>🔎 ${LABEL[a1].toUpperCase()} — MARKET P2P</b>\nChọn loại quảng cáo của merchant:`,
      markup: kb([[btn('🟢 Ads MUA (merchant mua USDT)', `ms:${a1}:BUY`)], [btn('🔴 Ads BÁN (merchant bán USDT)', `ms:${a1}:SELL`)], [btn('⬅️ Quay lại', 'x:mk'), ...backMain()]]),
    });
    case 'ms': return show(marketFilterScreen(a1, a2));
    case 'mf':
      if (a3 === 'c') {
        sess.awaiting = { type: 'minQty', ex: a1, side: a2, at: Date.now() };
        return send(chatId, '✍️ Gõ số lượng khả dụng tối thiểu (USDT), vd: 2000', kb([[btn('❌ Hủy', 'cx')]]));
      }
      market.setMinQty(a1, Number(a3) || 0, { source: 'telegram' });
      return show(await marketScreen(a1, a2, 0));
    case 'ml': return show(await marketScreen(a1, a2, Number(a3) || 0));
    case 'mr': return show(await marketScreen(a1, a2, Number(a3) || 0, { maxAgeMs: 3000 }));
    // Giá tốt nhất: 1 sàn → màn hình cài đặt (Limit Min riêng); tất cả → tổng hợp
    case 'bp': return show(a1 === 'all' ? await bestScreen('all') : bpSettingsScreen(a1));
    case 'bpr': return show(await bestScreen(a1, { maxAgeMs: 3000 }));
    case 'bq': return show(bpQtyScreen(a1));
    case 'bqs':
      if (a2 === 'c') {
        sess.awaiting = { type: 'bestLimitMin', ex: a1, at: Date.now() };
        return send(chatId, `✍️ Gõ Limit Min (VND) cho ${LABEL[a1]}, vd: 2,000,000 · 2tr · 1.500.000`, kb([[btn('❌ Hủy', 'cx')]]));
      }
      market.setLimitMin(a1, Number(a2) || 0, { source: 'telegram' });
      return show(bpSettingsScreen(a1));
    case 'bs': return show(await bestDetailScreen(a1, a2));
    case 'bsr': return show(await bestDetailScreen(a1, a2, { maxAgeMs: 3000 }));
    case 'rf': await edit(msg, '⏳ Đang làm mới...'); return show(await refreshScreen(a1));
    default: return show(mainMenu());
  }
}

async function handleUpdate(u) {
  try {
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  } catch (err) {
    logger.error('[Telegram] handle error:', st.client ? st.client.sanitize(err.message) : err.message);
    const chatId = u.message?.chat?.id || u.callback_query?.message?.chat?.id;
    if (chatId && authorized(u.message?.from || u.callback_query?.from, u.message?.chat || u.callback_query?.message?.chat)) {
      try { await send(chatId, `⚠️ Lỗi xử lý: ${esc(st.client.sanitize(err.message)).slice(0, 300)}`, kb([backMain()])); } catch (_) {}
    }
  }
}

// ══════════════════════════════════════════════════════════
// VÒNG POLLING
// ══════════════════════════════════════════════════════════
async function pollLoop(id) {
  let backoff = 2000;
  while (st.running && st.loopId === id) {
    try {
      const updates = await st.client.call('getUpdates', { offset: st.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: 35000 });
      if (!st.running || st.loopId !== id) break;
      st.lastOkAt = Date.now(); st.lastError = null; backoff = 2000;
      for (const u of updates) {
        st.offset = Math.max(st.offset, u.update_id + 1);
        await handleUpdate(u);
      }
      emitStatusThrottled();
    } catch (err) {
      st.lastError = err.message; st.lastErrorAt = Date.now();
      emitStatus();
      if (err.tgCode === 401 || err.tgCode === 404) {   // token sai → dừng hẳn, không spam
        logger.error('[Telegram] Bot Token không hợp lệ — dừng bot');
        st.running = false; emitStatus(); break;
      }
      if (err.tgCode === 409) logger.warn('[Telegram] Có tiến trình khác đang dùng cùng bot (409) — thử lại sau');
      const wait = err.retryAfter ? err.retryAfter * 1000 : backoff;
      await sleep(wait);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}
let lastEmit = 0;
function emitStatusThrottled() { if (Date.now() - lastEmit > 15000) { lastEmit = Date.now(); emitStatus(); } }

async function start() {
  const c = cfg();
  stop(true);
  if (!c.botToken) throw new Error('Chưa có Bot Token');
  st.client = new TelegramClient(c.botToken);
  st.me = await st.client.call('getMe');
  st.running = true; st.startedAt = Date.now(); st.lastOkAt = Date.now(); st.lastError = null;
  st.loopId++;
  logger.info(`[Telegram] Bot @${st.me.username} đang chạy (long polling)`);
  pollLoop(st.loopId);
  emitStatus();
  return st.me;
}

function stop(silent = false) {
  if (st.running && !silent) logger.info('[Telegram] Bot đã dừng');
  st.running = false; st.loopId++;
  emitStatus();
}

async function startFromSettings() {
  const c = cfg();
  if (c.enabled && c.botToken) {
    try { await start(); }
    catch (err) { st.lastError = st.client ? st.client.sanitize(err.message) : err.message; st.lastErrorAt = Date.now(); logger.error('[Telegram] Không khởi động được:', st.lastError); emitStatus(); }
  }
}

/** Lưu cấu hình từ dashboard. botToken rỗng = giữ token cũ. */
async function configure({ botToken, userId, chatId, enabled }) {
  const cur = cfg();
  const patch = {};
  if (typeof botToken === 'string' && botToken.trim()) patch.botToken = botToken.trim();
  if (userId !== undefined) patch.userId = String(userId).trim();
  if (chatId !== undefined) patch.chatId = String(chatId).trim();
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (patch.userId !== undefined && patch.userId && !/^\d+$/.test(patch.userId)) throw new Error('User ID phải là số');
  if (patch.chatId !== undefined && patch.chatId && !/^-?\d+$/.test(patch.chatId)) throw new Error('Chat ID phải là số');
  saveCfg(patch);
  audit.record({
    parameter: 'telegram', source: 'web', status: 'success',
    previous: { userId: cur.userId || '', chatId: cur.chatId || '', enabled: !!cur.enabled, botToken: cur.botToken ? 'set' : '' },
    next: { userId: cfg().userId || '', chatId: cfg().chatId || '', enabled: !!cfg().enabled, botToken: patch.botToken ? 'changed' : (cur.botToken ? 'set' : '') },
  });
  const after = cfg();
  if (after.enabled && after.botToken) {
    if (patch.botToken || !st.running) {
      try { await start(); } catch (err) { st.lastError = st.client ? st.client.sanitize(err.message) : err.message; st.lastErrorAt = Date.now(); emitStatus(); }
    }
  } else stop();
  return publicStatus();
}

/** Kiểm tra: token hợp lệ (getMe) + gửi được tin nhắn tới Chat ID đã cấu hình */
async function test() {
  const c = cfg();
  if (!c.botToken) return { ok: false, msg: 'Chưa có Bot Token' };
  const client = new TelegramClient(c.botToken);
  try {
    const me = await client.call('getMe');
    if (!c.chatId) return { ok: false, msg: `Token hợp lệ (@${me.username}) nhưng chưa có Chat ID` };
    await client.call('sendMessage', { chat_id: c.chatId, text: `✅ Kết nối thành công với P2P Auto System.\nGửi /menu để mở menu.` });
    return { ok: true, msg: `Đã gửi tin nhắn thử tới chat ${c.chatId} qua @${me.username}`, botUsername: me.username };
  } catch (err) {
    return { ok: false, msg: client.sanitize(err.message) };
  }
}

module.exports = { startFromSettings, start, stop, configure, test, status: publicStatus, _handleUpdate: handleUpdate };
