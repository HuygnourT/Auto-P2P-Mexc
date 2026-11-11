/**
 * Thao tác thay đổi tham số quảng cáo — dùng chung quy tắc kiểm tra cho Telegram và web.
 *
 * Tham số (tên chung → ý nghĩa):
 *   quantity   Số lượng quảng cáo (USDT)         → cập nhật lên SÀN ngay (giữ nguyên giá)
 *   ceiling    Trần giá (VND)                    → cấu hình engine, rồi tính lại giá
 *   floor      Sàn giá (VND)                     → cấu hình engine, rồi tính lại giá
 *   tradingQty Số lượng GD / SL tìm giá (VND)    → cấu hình engine (lọc ads đối thủ), rồi tính lại giá
 *   min / max  Giới hạn giao dịch (VND)          → cập nhật lên SÀN, thành công mới lưu vào cấu hình
 *   enabled    Bật/tắt auto pricing cho ad
 *
 * Quy trình mỗi thay đổi: kiểm tra → khoá → (sàn xác nhận nếu cần) → lưu cấu hình → báo engine
 * → đồng bộ web (qua sự kiện) → ghi audit → trả kết quả thật.
 */
const store = require('./store');
const engine = require('./engine');
const adapters = require('./adapters');
const audit = require('./audit');
const { withLock, num, isBlank, fmt } = require('./util');

const PARAMS = {
  quantity: { label: 'Số lượng quảng cáo', kind: 'exchange' },
  ceiling: { label: 'Trần giá', kind: 'config' },
  floor: { label: 'Sàn giá', kind: 'config' },
  tradingQty: { label: 'Số lượng GD (SL tìm giá)', kind: 'config' },
  min: { label: 'Min giao dịch', kind: 'exchange+config' },
  max: { label: 'Max giao dịch', kind: 'exchange+config' },
  enabled: { label: 'Auto Pricing', kind: 'config' },
};

/** Thông tin đầy đủ 1 ad: dữ liệu sàn + cấu hình engine + trạng thái */
async function getAdView(ex, adId, { maxAgeMs = 10000 } = {}) {
  const r = await engine.refreshMyAds(ex, { maxAgeMs });
  const ad = engine.getMyAds(ex).find(a => a.id === String(adId));
  if (!ad) return { ok: false, error: r.ok ? 'Không tìm thấy quảng cáo — có thể đã bị xóa hoặc thay đổi ngoài tool' : r.error };
  const found = store.findAdCfg(ex, ad.id);
  const cfg = found ? found.cfg : store.defaultAdCfg(ex, ad);
  const isBuy = ad.side === 'BUY';
  const b = store.boundsOf(cfg, isBuy);
  const field = p => store.fieldFor(ex, p, isBuy);
  return {
    ok: true, ex, ad, key: found?.key ?? null, cfg, v: cfg._v || 1, isBuy,
    values: {
      quantity: ad.available, ceiling: b.ceiling, floor: b.floor,
      tradingQty: num(cfg[field('tradingQty')]),
      min: num(cfg[field('min')]) ?? ad.min, max: num(cfg[field('max')]) ?? ad.max,
      enabled: !!cfg.enabled,
    },
    rowStatus: found ? engine.rowStatusOf(ex)[found.key] || null : null,
    engine: engine.statusOf(ex),
    caps: adapters.get(ex).caps,
  };
}

function supported(ex, param) {
  const caps = adapters.get(ex).caps;
  if (param === 'quantity') return caps.editQuantity;
  if (param === 'min' || param === 'max') return caps.editMinMax;
  return { ok: true };
}

/**
 * Kiểm tra giá trị mới. value = null → xoá (chỉ cho trần/sàn/SL GD).
 * Trả { ok, value, error, warnings[] }
 */
function validate(view, param, value) {
  const { ex, ad, values, isBuy } = view;
  const warnings = [];
  if (!PARAMS[param]) return { ok: false, error: 'Tham số không hợp lệ' };
  const cap = supported(ex, param);
  if (!cap.ok) return { ok: false, error: `${adapters.get(ex).label} không hỗ trợ sửa ${PARAMS[param].label} qua API${cap.note ? ` (${cap.note})` : ''}` };
  if (param === 'enabled') return { ok: true, value: !!value, warnings };

  const clearable = ['ceiling', 'floor', 'tradingQty'];
  if (value === null || value === '') {
    if (clearable.includes(param)) return { ok: true, value: null, warnings };
    return { ok: false, error: 'Giá trị không được để trống' };
  }
  const v = num(value);
  if (v === null) return { ok: false, error: 'Giá trị phải là số' };
  if (v <= 0) return { ok: false, error: 'Giá trị phải lớn hơn 0' };

  if (param === 'floor' && values.ceiling !== null && v > values.ceiling) return { ok: false, error: `Sàn (${fmt(v)}) không được lớn hơn Trần (${fmt(values.ceiling)})` };
  if (param === 'ceiling' && values.floor !== null && v < values.floor) return { ok: false, error: `Trần (${fmt(v)}) không được nhỏ hơn Sàn (${fmt(values.floor)})` };
  if ((param === 'floor' || param === 'ceiling') && ad.price) {
    const ratio = v / ad.price;
    if (ratio < 0.5 || ratio > 1.5) warnings.push(`Giá trị lệch hơn 50% so với giá hiện tại (${fmt(ad.price)}) — kiểm tra lại`);
  }

  if (param === 'min') {
    if (values.max !== null && v > values.max) return { ok: false, error: `Min (${fmt(v)}) phải ≤ Max (${fmt(values.max)})` };
  }
  if (param === 'max') {
    if (values.min !== null && v < values.min) return { ok: false, error: `Max (${fmt(v)}) phải ≥ Min (${fmt(values.min)})` };
    const capAmt = (ad.available || 0) * (ad.price || 0);
    if (capAmt > 0 && v > capAmt) return { ok: false, error: `Max (${fmt(v)}) vượt quá số lượng khả dụng × giá (${fmt(capAmt)} ${ad.fiat})` };
  }
  if (param === 'quantity') {
    if (values.min !== null && ad.price && v * ad.price < values.min) return { ok: false, error: `Số lượng × giá (${fmt(v * ad.price)}) nhỏ hơn Min giao dịch (${fmt(values.min)})` };
    if (ex === 'bybit' && isBuy) {
      const row = store.findAdCfg('bybit', ad.id)?.cfg;
      if (row?.enabled && row.qtyMode !== 'keep') warnings.push(`Dòng Bybit đang ở chế độ "Refill ${fmt(20000)}" — engine sẽ đặt lại 20,000 ở lần đổi giá kế tiếp`);
    }
    if (ex === 'bitget') {
      const row = store.findAdCfg('bitget', ad.id)?.cfg;
      if (row && !isBlank(row.refillThreshold) && !isBlank(row.refillQuantity)) warnings.push('Dòng Bitget có cấu hình Refill — engine có thể refill lại theo ngưỡng');
    }
    if (ex === 'mexc') {
      const c = store.findAdCfg('mexc', ad.id)?.cfg;
      if (c && !isBlank(c.refillThreshold) && !isBlank(c.refillQuantity)) warnings.push('Ad MEXC có cấu hình Refill — engine có thể refill lại theo ngưỡng');
    }
    if (ex === 'bingx') warnings.push('BingX: giá trị này là TỔNG số lượng (totalNumber) của quảng cáo');
  }
  return { ok: true, value: v, warnings };
}

/**
 * Áp dụng thay đổi. meta: { source: 'telegram'|'web', expectV, client }
 * Trả { ok, msg, previous, next, exchangeStatus, recalc, warnings }
 */
async function apply(ex, adId, param, rawValue, meta = {}) {
  const source = meta.source || 'web';
  const base = { exchange: ex, adId, parameter: param, source };
  // Khoá theo sàn: chờ vòng quét đang chạy xong → engine không gửi đè giá trị cũ lên sàn
  return withLock(`cycle:${ex}`, async () => {
    const view = await getAdView(ex, adId, { maxAgeMs: 0 });
    if (!view.ok) {
      audit.record({ ...base, next: rawValue, status: 'failed', message: view.error });
      return { ok: false, msg: view.error };
    }
    if (meta.expectV != null && view.key !== null && Number(meta.expectV) !== view.v) {
      const msg = 'Cấu hình vừa được thay đổi ở nơi khác (web/Telegram) — mở lại quảng cáo và thử lại';
      audit.record({ ...base, next: rawValue, status: 'rejected', message: msg });
      return { ok: false, msg, conflict: true };
    }
    const chk = validate(view, param, rawValue);
    const previous = view.values[param];
    if (!chk.ok) {
      audit.record({ ...base, previous, next: rawValue, status: 'rejected', message: chk.error });
      return { ok: false, msg: chk.error, previous };
    }
    const value = chk.value;
    const a = adapters.get(ex);
    const field = store.fieldFor(ex, param, view.isBuy);
    let exchangeStatus = null;

    // 1. Phần cần sàn xác nhận
    if (param === 'quantity' || param === 'min' || param === 'max') {
      const cfgNow = view.cfg;
      const chg = { [param]: value };
      const r = await a.applyAdChange(view.ad, cfgNow, chg);
      exchangeStatus = r.exchangeStatus;
      if (!r.ok) {
        audit.record({ ...base, previous, next: value, status: 'failed', exchangeStatus, message: r.msg });
        return { ok: false, msg: `Sàn từ chối: ${r.msg}`, previous, next: value, exchangeStatus };
      }
    }

    // 2. Lưu cấu hình (sau khi sàn đã xác nhận nếu có)
    if (field && param !== 'quantity') {
      const { key } = store.ensureAdCfg(ex, view.ad, { source, client: meta.client });
      store.patchByKey(ex, key, { [field]: value === null ? '' : value }, { source, client: meta.client });
    }
    if (param === 'quantity' && ex === 'bitget') {
      const found = store.findAdCfg('bitget', view.ad.id);
      if (found && !isBlank(found.cfg.quantity)) store.patchByKey('bitget', found.key, { quantity: value }, { source, client: meta.client });
    }

    audit.record({ ...base, previous, next: value, status: 'success', exchangeStatus });
    await engine.refreshMyAds(ex).catch(() => {});

    // 3. Báo engine tính lại giá với cấu hình mới (trần/sàn/SL GD/bật)
    let recalc = null;
    if (['ceiling', 'floor', 'tradingQty', 'enabled'].includes(param)) {
      const key = store.findAdCfg(ex, view.ad.id)?.key;
      if (key !== undefined && key !== null) {
        recalc = await engine.runCycle(ex, { onlyKeys: new Set([String(key)]), dryRun: !(engine.statusOf(ex).running && store.getByKey(ex, key)?.enabled), marketMaxAge: 15000 })
          .then(rr => {
            const res = rr.results[key] || rr.results[String(key)] || {};
            const running = engine.statusOf(ex).running;
            const enabled = !!store.getByKey(ex, key)?.enabled;
            return {
              applied: !!res.updated, target: res.target ?? null, current: res.current ?? null, best: res.best ?? null, error: rr.error,
              status: engine.rowStatusOf(ex)[key]?.msg || null,
              note: running && enabled ? null : (!running ? 'Auto-pricer của sàn đang dừng — giá sẽ áp dụng khi bật' : 'Auto-pricing của ad này đang tắt'),
            };
          }).catch(err => ({ error: err.message }));
        if (recalc?.applied) audit.record({ exchange: ex, adId, parameter: 'price', previous: recalc.current, next: recalc.target, source: 'engine', status: 'success', message: `Tính lại sau khi đổi ${PARAMS[param].label}` });
      }
    }
    return { ok: true, msg: 'Đã áp dụng', previous, next: value, exchangeStatus, recalc, warnings: chk.warnings };
  });
}

module.exports = { PARAMS, getAdView, validate, apply, supported };
