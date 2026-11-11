/**
 * API engine / cấu hình chung / market / audit + luồng sự kiện realtime (SSE).
 * Web dashboard và Telegram Bot cùng dùng các thành phần phía sau những route này.
 */
const express = require('express');
const router = express.Router();
const bus = require('../core/bus');
const store = require('../core/store');
const engine = require('../core/engine');
const market = require('../core/market');
const adapters = require('../core/adapters');
const audit = require('../core/audit');
const ops = require('../core/ops');
const { num } = require('../core/util');

const EXS = adapters.EXCHANGES;
function exParam(req, res) {
  const ex = req.params.ex;
  if (!EXS.includes(ex)) { res.status(400).json({ code: -1, msg: 'Sàn không hợp lệ' }); return null; }
  return ex;
}
const clientOf = req => req.get('X-Client-Id') || null;

function exState(ex) {
  const sec = store.section(ex);
  return {
    status: engine.statusOf(ex),
    settings: store.globalOf(ex),
    configs: ex === 'mexc' ? sec.apConfigs : ex === 'bingx' ? sec.configs : undefined,
    rows: store.ROW_EX.has(ex) ? sec.rows : undefined,
    rowStatus: engine.rowStatusOf(ex),
    logs: engine.logsOf(ex, 100),
    myAds: engine.getMyAds(ex).map(({ raw, ...a }) => a),
    caps: adapters.get(ex).caps,
  };
}

// ── SSE ──
router.get('/events', bus.sseHandler);

// ── Trạng thái + cấu hình ──
router.get('/engine/state', (_req, res) => {
  res.json({ code: 0, data: Object.fromEntries(EXS.map(ex => [ex, exState(ex)])) });
});
router.get('/engine/:ex/state', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  res.json({ code: 0, data: exState(ex) });
});
router.get('/engine/caps', (_req, res) => {
  res.json({ code: 0, data: Object.fromEntries(EXS.map(ex => [ex, { label: adapters.get(ex).label, ...adapters.get(ex).caps }])) });
});

// ── Bật / dừng ──
router.post('/engine/:ex/start', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  if (req.body?.scanInterval) store.patchSettings(ex, { scanInterval: req.body.scanInterval }, { source: 'web', client: clientOf(req) });
  const r = engine.start(ex, { source: 'web' });
  audit.record({ exchange: ex, parameter: 'autoPricer', next: 'start', source: 'web', status: r.ok ? 'success' : 'failed', message: r.msg });
  res.json({ code: r.ok ? 0 : -1, msg: r.msg, data: engine.statusOf(ex) });
});
router.post('/engine/:ex/stop', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  engine.stop(ex, { source: 'web' });
  audit.record({ exchange: ex, parameter: 'autoPricer', next: 'stop', source: 'web', status: 'success' });
  res.json({ code: 0, data: engine.statusOf(ex) });
});

// ── Cấu hình toàn cục ──
router.post('/engine/:ex/settings', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  const changed = store.patchSettings(ex, req.body || {}, { source: 'web', client: clientOf(req) });
  for (const [f, c] of Object.entries(changed)) audit.record({ exchange: ex, parameter: f, previous: c.previous, next: c.next, source: 'web', status: 'success' });
  res.json({ code: 0, data: store.globalOf(ex) });
});

/**
 * Sửa cấu hình 1 ad (mexc/bingx: key = mã ad) hoặc 1 dòng (bitget/bybit: key = id dòng).
 * body: { patch: {field: value}, expectV }
 */
router.post('/engine/:ex/ads/:key', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  const { patch = {}, expectV } = req.body || {};
  const key = req.params.key;
  try {
    let cfg = store.getByKey(ex, key);
    if (!cfg) {
      if (store.ROW_EX.has(ex)) return res.status(404).json({ code: -1, msg: 'Không tìm thấy dòng cấu hình' });
      const ad = engine.getMyAds(ex).find(a => a.id === String(key)) || { id: key };
      cfg = store.ensureAdCfg(ex, ad, { source: 'web', client: clientOf(req) }).cfg;
    }
    const isBuy = store.ROW_EX.has(ex) ? (patch.side ?? cfg.side) === 'buy'
      : (engine.getMyAds(ex).find(a => a.id === String(key))?.side || 'BUY') === 'BUY';
    const err = validateConfigPatch(cfg, patch, isBuy);
    if (err) return res.json({ code: -1, msg: err, data: cfg });
    const { cfg: updated, changed } = store.patchByKey(ex, key, patch, { source: 'web', client: clientOf(req), expectV });
    for (const [f, c] of Object.entries(changed)) {
      audit.record({ exchange: ex, adId: updated.advId || key, parameter: f, previous: c.previous, next: c.next, source: 'web', status: 'success' });
    }
    res.json({ code: 0, data: updated });
  } catch (e) {
    if (e.code === 'VERSION_CONFLICT') return res.status(409).json({ code: 409, msg: e.message, data: e.current });
    res.status(400).json({ code: -1, msg: e.message });
  }
});

/** Quy tắc kiểm tra chung cho web (giống Telegram): Sàn ≤ Trần, Min ≤ Max, số hợp lệ */
function validateConfigPatch(cfg, patch, isBuy) {
  const next = { ...cfg, ...patch };
  const NUMERIC = ['amount', 'searchAmount', 'offset', 'priceLimit', 'priceFloor', 'priceCeiling', 'minTrans', 'maxTrans',
    'minAmount', 'maxAmount', 'quantity', 'refillThreshold', 'refillQuantity', 'refill', 'onlineMinutes', 'minTrades30d'];
  for (const f of Object.keys(patch)) {
    if (NUMERIC.includes(f) && patch[f] !== '' && patch[f] !== null && num(patch[f]) === null) return `"${f}" phải là số`;
  }
  const b = store.boundsOf(next, isBuy);
  if (b.floor !== null && b.ceiling !== null && b.floor > b.ceiling) return `Sàn (${b.floor}) không được lớn hơn Trần (${b.ceiling})`;
  const mn = num(next.minTrans ?? next.minAmount), mx = num(next.maxTrans ?? next.maxAmount);
  if (mn !== null && mn <= 0 && ('minTrans' in patch || 'minAmount' in patch)) return 'Min phải lớn hơn 0';
  if (mn !== null && mx !== null && mx < mn) return `Max (${mx}) phải ≥ Min (${mn})`;
  return null;
}

router.post('/engine/:ex/rows', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  try {
    const row = store.addRow(ex, req.body || {}, { source: 'web', client: clientOf(req) });
    audit.record({ exchange: ex, adId: row.advId, parameter: 'row', next: `thêm dòng #${row.id}`, source: 'web', status: 'success' });
    res.json({ code: 0, data: row });
  } catch (e) { res.status(400).json({ code: -1, msg: e.message }); }
});
router.post('/engine/:ex/rows/:key/delete', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  try {
    const row = store.getByKey(ex, req.params.key);
    const ok = store.removeRow(ex, req.params.key, { source: 'web', client: clientOf(req) });
    if (ok) audit.record({ exchange: ex, adId: row?.advId, parameter: 'row', previous: `dòng #${req.params.key}`, next: 'xóa', source: 'web', status: 'success' });
    res.json({ code: ok ? 0 : -1 });
  } catch (e) { res.status(400).json({ code: -1, msg: e.message }); }
});

// Thay đổi tham số ad theo quy trình đầy đủ (như Telegram): kiểm tra → sàn xác nhận → lưu → tính lại giá
router.post('/engine/:ex/ad/:adId/param', async (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  const { param, value, expectV } = req.body || {};
  const r = await ops.apply(ex, req.params.adId, param, value, { source: 'web', expectV, client: clientOf(req) });
  res.json({ code: r.ok ? 0 : -1, msg: r.msg, data: r });
});

// Ads của tôi dạng gốc từ sàn, lấy từ cache của engine (KHÔNG gọi lại sàn) — để bảng trên web hiển thị như cũ
router.get('/engine/:ex/raw-ads', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  const st = engine.statusOf(ex);
  res.json({ code: 0, data: engine.getMyAds(ex).map(a => a.raw), at: st.myAdsAt, error: st.myAdsError });
});

router.post('/engine/:ex/refresh', async (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  const r = await engine.refreshMyAds(ex);
  res.json({ code: r.ok ? 0 : -1, msg: r.error, data: engine.getMyAds(ex).map(({ raw, ...a }) => a) });
});

// ── Market dùng chung ──
router.get('/market/best', async (req, res) => {
  const list = req.query.ex && req.query.ex !== 'all' ? [req.query.ex] : EXS;
  const minQty = num(req.query.minQty) || 0, amount = num(req.query.amount) || 0;
  // limitMin: số VND, hoặc "saved" = dùng Limit Min đã lưu của từng sàn (giống Telegram). Mặc định không lọc.
  const lmOf = ex => (req.query.limitMin === 'saved' ? market.getLimitMin(ex) : num(req.query.limitMin) || 0);
  const out = {};
  const maxAgeMs = req.query.fresh === '1' ? 3000 : 30000;
  for (const ex of list) {
    if (!EXS.includes(ex)) continue;
    try { out[ex] = await market.best(ex, { minQty, limitMin: lmOf(ex), amount, maxAgeMs, cfgSection: store.section(ex) }); }
    catch (e) { out[ex] = { ex, error: e.message }; }
  }
  res.json({ code: 0, data: out });
});
router.get('/market/list', async (req, res) => {
  const { ex, side } = req.query;
  if (!EXS.includes(ex) || !['BUY', 'SELL'].includes(side)) return res.status(400).json({ code: -1, msg: 'ex/side không hợp lệ' });
  const maxAgeMs = req.query.fresh === '1' ? 3000 : 15000;
  const r = await market.list(ex, side, { minQty: num(req.query.minQty) || 0, maxAgeMs, cfgSection: store.section(ex) });
  res.json({ code: r.ok ? 0 : -1, msg: r.error, data: { ...r, items: (r.items || []).slice(0, 50).map(({ raw, ...m }) => m) } });
});

// Bộ lọc SL khả dụng tối thiểu theo từng sàn (dùng chung Telegram ↔ web)
router.get('/market/filters', (_req, res) => res.json({ code: 0, data: market.minQtyAll() }));
router.post('/market/filters/:ex', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  try { res.json({ code: 0, data: market.setMinQty(ex, req.body?.minQty, { source: 'web', client: clientOf(req) }) }); }
  catch (e) { res.status(400).json({ code: -1, msg: e.message }); }
});

// Bộ lọc Limit Min (VND) của Giá tốt nhất theo từng sàn (dùng chung Telegram ↔ tool)
router.get('/market/best-filters', (_req, res) => res.json({ code: 0, data: market.limitMinAll() }));
router.post('/market/best-filters/:ex', (req, res) => {
  const ex = exParam(req, res); if (!ex) return;
  try { res.json({ code: 0, data: market.setLimitMin(ex, req.body?.limitMin, { source: 'web', client: clientOf(req) }) }); }
  catch (e) { res.status(400).json({ code: -1, msg: e.message }); }
});

router.get('/audit', (req, res) => {
  res.json({ code: 0, data: audit.recent(Math.min(200, parseInt(req.query.limit) || 50)) });
});

module.exports = router;
