/**
 * ============================================================
 * MEXC P2P System — Frontend Application
 * ============================================================
 * Quản lý toàn bộ logic giao diện: kết nối API, hiển thị ads,
 * chuyển tab, phân trang, toast thông báo.
 * Sử dụng IIFE pattern (App module) để đóng gói state và methods.
 * ============================================================
 */

const App = (() => {
  // ─── State: Trạng thái toàn cục của ứng dụng ─────────
  let state = {
    connected: false,           // Đã kết nối API chính chưa
    secondaryConnected: false,  // Đã kết nối API phụ chưa
    currentTab: 'buy',          // Tab đang chọn: 'buy' hoặc 'sell'
    loading: false,             // Đang tải dữ liệu

    // ── Market Ads (raw = toàn bộ từ API, filtered = sau lọc) ──
    buyAdsRaw: [],
    sellAdsRaw: [],
    buyAds: [],
    sellAds: [],
    buyPage: { startPage: 1, fetchedUpTo: 1, total: 1, history: [] },
    sellPage: { startPage: 1, fetchedUpTo: 1, total: 1, history: [] },
    fiatUnit: 'VND',

    // ── Bộ lọc Market Ads ──
    marketFilters: {
      onlineMinutes: 0,
      amount: 0,
      autoRefreshSec: 0,
    },

    // ── My Ads state ──
    myAds: [],
    myAdsFiltered: [],
    myAdsFilter: 'ALL',
    myAdsPage: { current: 1, total: 1 },

    // ── Auto-pricer state ──
    myAdvNos: new Set(),
    apConfigs: {},

    // ★ MỚI: Whitelist thương nhân — bỏ qua khi tìm giá tốt nhất
    whitelist: [],

    // ★ MỚI: Bitget P2P
    bgConnected: false,
    bgAds: [],
    bgApConfigs: {},
    // ★ MỚI: Bitget Market Ads
    bgMarketTab: 'buy',
    bgMarketBuy: [],
    bgMarketSell: [],
    bgMarketBuyPage: 1,
    bgMarketSellPage: 1,
    // ★ Bitget auto-pricer: danh sách dòng cấu hình tùy chỉnh
    bgApRows: [],   // [{ id, side:'buy'|'sell', advId, priceLimit, enabled, lastStatus }]

    byConnected: false,
    byAds: [],
  };

  // Timer auto-refresh (handle của setInterval)
  let autoRefreshTimer = null;

  // ★ MỚI: Binance price polling
  let bnPriceTimer = null;
  let pbTimer = null;
  let bnCountdown = 60;

  // ★ MỚI: Bitget auto-pricer timer
  let bgApTimer = null;
  let bgApRowSeq = 1;

  // ─── API Client: Gửi request đến backend ─────────────
  const api = {
    async post(url, data) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      return res.json();
    },
    async get(url) {
      const res = await fetch(url);
      return res.json();
    },
  };

  // ═══════════════════════════════════════════════════════
  // ★ MỚI: WHITELIST THƯƠNG NHÂN
  // ═══════════════════════════════════════════════════════

  /**
   * Lấy whitelist từ server và lưu vào state.
   */
  async function loadWhitelist() {
    try {
      const result = await api.get('/api/whitelist');
      if (result.code === 0) {
        state.whitelist = result.data || [];
        renderWhitelist();
      }
    } catch (err) {
      console.error('[Whitelist] Load error:', err);
    }
  }

  /**
   * Thêm thương nhân vào whitelist.
   * Đọc tên từ input #wlInput, gửi POST /api/whitelist/add.
   */
  async function addWhitelistMerchant() {
    const input = document.getElementById('wlInput');
    const name = (input.value || '').trim();
    if (!name) {
      showToast('Vui lòng nhập tên thương nhân', 'error');
      return;
    }

    // Kiểm tra trùng phía client
    if (state.whitelist.some(m => m.toLowerCase() === name.toLowerCase())) {
      showToast('Thương nhân đã có trong whitelist', 'info');
      input.value = '';
      return;
    }

    try {
      const result = await api.post('/api/whitelist/add', { name });
      if (result.code === 0) {
        state.whitelist = result.data;
        renderWhitelist();
        input.value = '';
        showToast(`Đã thêm "${name}" vào whitelist`, 'success');
      }
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  }

  /**
   * Xóa thương nhân khỏi whitelist.
   * @param {string} name - Tên thương nhân cần xóa
   */
  async function removeWhitelistMerchant(name) {
    try {
      const result = await api.post('/api/whitelist/remove', { name });
      if (result.code === 0) {
        state.whitelist = result.data;
        renderWhitelist();
        showToast(`Đã xóa "${name}" khỏi whitelist`, 'info');
      }
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  }

  /**
   * Render danh sách whitelist dưới dạng chip tags.
   */
  function renderWhitelist() {
    const container = document.getElementById('wlChips');
    const countEl = document.getElementById('wlCount');
    if (!container) return;

    // Cập nhật counter
    if (countEl) {
      countEl.textContent = state.whitelist.length > 0
        ? `${state.whitelist.length} thương nhân`
        : '';
    }

    if (state.whitelist.length === 0) {
      container.innerHTML = '<span class="wl-empty" id="wlEmpty">Chưa có thương nhân nào trong whitelist</span>';
      return;
    }

    container.innerHTML = state.whitelist.map(name => {
      // Escape tên cho attribute onclick
      const escaped = escapeHtml(name);
      const escapedAttr = escaped.replace(/'/g, "\\'");
      return `
        <span class="wl-chip">
          <span class="wl-chip-name">${escaped}</span>
          <button class="wl-chip-remove" onclick="App.removeWhitelistMerchant('${escapedAttr}')" title="Xóa khỏi whitelist">&times;</button>
        </span>`;
    }).join('');
  }

  async function loadSettings() {
  try {
    const r = await api.get('/api/settings');
    if (r.code === 0 && r.data) state.savedSettings = r.data;
  } catch (e) { console.error('[Settings]', e); }
}

// Điền sẵn thông tin đăng nhập đã lưu vào các ô input
function prefillCredentials() {
  const s = state.savedSettings || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  if (s.mexc) {
    set('apiKey', s.mexc.apiKey); set('secretKey', s.mexc.secretKey); set('apiHost', s.mexc.apiHost);
    set('apiKey2', s.mexc.apiKey2); set('secretKey2', s.mexc.secretKey2); set('apiHost2', s.mexc.apiHost2);
  }
  if (s.bitget) {
    set('bgApiKey', s.bitget.apiKey); set('bgSecretKey', s.bitget.secretKey); set('bgPassphrase', s.bitget.passphrase);
  }

  if (s.bybit) {
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('byApiKey', s.bybit.apiKey); set('byApiSecret', s.bybit.apiSecret);
  }
}

async function saveMexcCreds() {
  const data = {
    apiKey: document.getElementById('apiKey').value.trim(),
    secretKey: document.getElementById('secretKey').value.trim(),
    apiHost: document.getElementById('apiHost').value,
    apiKey2: document.getElementById('apiKey2').value.trim(),
    secretKey2: document.getElementById('secretKey2').value.trim(),
    apiHost2: document.getElementById('apiHost2').value,
  };
  const r = await api.post('/api/settings/mexc', data);
  if (r.code === 0) { state.savedSettings = r.data; showToast('Đã lưu thông tin đăng nhập MEXC', 'success'); }
  else showToast('Lỗi lưu: ' + (r.msg || ''), 'error');
}

async function saveBitgetCreds() {
  const data = {
    apiKey: document.getElementById('bgApiKey').value.trim(),
    secretKey: document.getElementById('bgSecretKey').value.trim(),
    passphrase: document.getElementById('bgPassphrase').value.trim(),
  };
  const r = await api.post('/api/settings/bitget', data);
  if (r.code === 0) { state.savedSettings = r.data; showToast('Đã lưu thông tin đăng nhập Bitget', 'success'); }
  else showToast('Lỗi lưu: ' + (r.msg || ''), 'error');
}

async function saveBybitCreds() {
  const data = {
    apiKey: document.getElementById('byApiKey').value.trim(),
    apiSecret: document.getElementById('byApiSecret').value.trim(),
  };
  const r = await api.post('/api/settings/bybit', data);
  if (r.code === 0) { state.savedSettings = r.data; showToast('Đã lưu đăng nhập Bybit', 'success'); }
  else showToast('Lỗi lưu: ' + (r.msg || ''), 'error');
}

async function saveMexcPricer() {
  const data = {
    scanInterval: document.getElementById('apScanInterval').value,
    apConfigs: state.apConfigs,
  };
  const r = await api.post('/api/settings/mexcPricer', data);
  if (r.code === 0) { state.savedSettings = r.data; showToast('Đã lưu cấu hình auto-pricer MEXC', 'success'); }
  else showToast('Lỗi lưu: ' + (r.msg || ''), 'error');
}

async function saveBitgetPricer() {
  const data = {
    scanInterval: document.getElementById('bgScanInterval').value,
    offsetBuy: document.getElementById('bgOffsetBuy').value,
    offsetSell: document.getElementById('bgOffsetSell').value,
    rows: state.bgApRows,
  };
  const r = await api.post('/api/settings/bitgetPricer', data);
  if (r.code === 0) { state.savedSettings = r.data; showToast('Đã lưu cấu hình auto-pricer Bitget', 'success'); }
  else showToast('Lỗi lưu: ' + (r.msg || ''), 'error');
}

// Khôi phục cấu hình MEXC sau khi đã loadMyAds (KHÔNG tự chạy)
function restoreMexcPricerConfig() {
  const saved = state.savedSettings?.mexcPricer;
  if (!saved) return;
  if (saved.scanInterval) document.getElementById('apScanInterval').value = saved.scanInterval;
  if (saved.apConfigs) {
    for (const [advNo, cfg] of Object.entries(saved.apConfigs)) {
      state.apConfigs[advNo] = { ...cfg };   // ghi đè cấu hình mặc định
    }
  }
}

// Khôi phục cấu hình Bitget sau khi connect (KHÔNG tự chạy)
function restoreBitgetPricerConfig() {
  const saved = state.savedSettings?.bitgetPricer;
  if (!saved) return;
  if (saved.scanInterval) document.getElementById('bgScanInterval').value = saved.scanInterval;
  if (saved.offsetBuy != null && saved.offsetBuy !== '') document.getElementById('bgOffsetBuy').value = saved.offsetBuy;
  if (saved.offsetSell != null && saved.offsetSell !== '') document.getElementById('bgOffsetSell').value = saved.offsetSell;
  if (Array.isArray(saved.rows) && saved.rows.length) {
    state.bgApRows = saved.rows.map(r => ({ ...r, lastStatus: '' }));  // giữ enabled, reset trạng thái
    bgApRowSeq = Math.max(0, ...state.bgApRows.map(r => r.id || 0)) + 1;
    renderBgApRows();
  }
}

  // ═══════════════════════════════════════════════════════
  // ★ MỚI: BINANCE PRICE — Hiển thị giá từ pricedancing.com
  // ═══════════════════════════════════════════════════════

  async function loadBinancePrice() {
    try {
      const result = await api.get('/api/binance/price');
      if (result.code === 0 && result.data.price) {
        document.getElementById('bnPriceValue').textContent = formatNumber(result.data.price);
        const time = result.data.lastUpdated
          ? new Date(result.data.lastUpdated).toLocaleTimeString('vi-VN')
          : '—';
        document.getElementById('bnPriceTime').textContent = `Cập nhật: ${time}`;
        bnCountdown = 60;
      }
    } catch (err) {
      console.error('[BinancePrice]', err);
    }
  }

  function startBinancePricePolling() {
    loadBinancePrice();
    bnPriceTimer = setInterval(() => {
      bnCountdown--;
      const el = document.getElementById('bnPriceCountdown');
      if (el) el.textContent = `${bnCountdown}s`;
      if (bnCountdown <= 0) {
        loadBinancePrice();
      }
    }, 1000);
  }

  // Lấy giá tốt nhất MEXC cho khung hiển thị. undefined = chưa kết nối, null = không có giá.
async function fetchMexcBest(side, amount) {
  if (!state.secondaryConnected) return undefined;
  const amountParam = amount > 0 ? `&amount=${amount}` : '';
  try {
    const r = await api.get(`/api/market/ads?side=${side}&fiatUnit=VND&page=1&coinId=128f589271cb4951b03e71e6323eb7be&blockTrade=true&allowTrade=true&countryCode=VN${amountParam}`);
    if (r.code !== 0) return null;
    let best = null;
    for (const ad of (r.data || [])) {
      const p = parseFloat(ad.price);
      if (isNaN(p)) continue;
      best = best === null ? p : (side === 'BUY' ? Math.max(best, p) : Math.min(best, p));
    }
    return best;
  } catch (_) { return null; }
}

async function fetchBitgetBest(side, amount) {
  if (!state.bgConnected) return undefined;
  const amountParam = amount > 0 ? `&amount=${amount}` : '';
  try {
    const r = await api.get(`/api/bitget/market?side=${side}&token=USDT&fiat=VND&pageNum=1&limit=10${amountParam}`);
    if (r.code !== '00000') return null;
    let best = null;
    for (const ad of r.data.items) {
      const p = parseFloat(ad.price);
      if (isNaN(p)) continue;
      best = best === null ? p : (side === 'buy' ? Math.min(best, p) : Math.max(best, p));
    }
    return best;
  } catch (_) { return null; }
}

function setPbCell(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value === undefined) el.textContent = 'Chưa kết nối';
  else if (value === null) el.textContent = '—';
  else el.textContent = formatNumber(value);
}

async function refreshPriceBoard() {
  const amount = parseFloat(document.getElementById('pbAmount')?.value) || 0;
  const [mb, ms, bb, bs] = await Promise.all([
    fetchMexcBest('BUY', amount),
    fetchMexcBest('SELL', amount),
    fetchBitgetBest('sell', amount),
    fetchBitgetBest('buy', amount),
  ]);
  setPbCell('pbMexcBuy', mb);
  setPbCell('pbMexcSell', ms);
  setPbCell('pbBitgetBuy', bb);
  setPbCell('pbBitgetSell', bs);
}

function startPriceBoardPolling() {
  refreshPriceBoard();
  pbTimer = setInterval(refreshPriceBoard, 15000);  // tự cập nhật mỗi 15s
}

  // ═══════════════════════════════════════════════════════
  // ★ MỚI: BITGET P2P
  // ═══════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════
  // ★ MỚI: BITGET MARKET ADS
  // ═══════════════════════════════════════════════════════

  async function loadBgMarket(side) {
  if (!state.bgConnected) { showToast('Chưa kết nối Bitget', 'error'); return; }

  const amount = document.getElementById('bgFilterAmount')?.value || '';

  // Không chỉ định side → tải cả buy + sell; có side → chỉ tải side đó (dùng cho phân trang)
  const sidesToLoad = side ? [side] : ['buy', 'sell'];

  for (const loadSide of sidesToLoad) {
    const pageKey = loadSide === 'buy' ? 'bgMarketBuyPage' : 'bgMarketSellPage';
    try {
      const params = `side=${loadSide}&token=USDT&fiat=VND&pageNum=${state[pageKey]}&limit=10${amount ? '&amount=' + amount : ''}`;
      const r = await api.get(`/api/bitget/market?${params}`);
      console.log('[BgMarket]', loadSide, r);

      if (r.code === '00000') {
        const ads = r.data.items;
        if (loadSide === 'buy') state.bgMarketBuy = ads;
        else state.bgMarketSell = ads;
        renderBgMarketTable(loadSide);
      } else {
        showToast(`Lỗi: ${r.msg || 'Không tải được dữ liệu'}`, 'error');
      }
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  }
}

  function renderBgMarketTable(side) {
    const ads = side === 'buy' ? state.bgMarketBuy : state.bgMarketSell;
    const tbody = document.getElementById(side === 'buy' ? 'bgBuyMarketBody' : 'bgSellMarketBody');
    const pagEl = document.getElementById(side === 'buy' ? 'bgBuyMarketPagination' : 'bgSellMarketPagination');
    if (!tbody) return;

    if (!ads || ads.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state"><p>Không có quảng cáo</p></div></td></tr>`;
      if (pagEl) pagEl.innerHTML = '';
      return;
    }

    tbody.innerHTML = ads.map((ad, i) => {
      const isBuy = ad.side === 'buy';
      const payments = (ad.payMethods || []).map(p => p.payMethodName || `PM-${p.payMethodId}`).join(', ') || '—';
      const completedRate = ad.completedRate ? (parseFloat(ad.completedRate) * 100).toFixed(1) + '%' : '—';
      return `<tr class="ad-row" style="animation-delay:${i * 0.04}s">
        <td class="merchant-cell">
          <div class="merchant-info">
            <span class="merchant-name">${escapeHtml(ad.merchantName || 'N/A')}</span>
            <span class="merchant-meta">${ad.completedOrderNum || 0} lệnh · ${completedRate}</span>
          </div>
        </td>
        <td class="price-cell">
          <span class="price-value ${isBuy ? 'price-buy' : 'price-sell'}">${formatNumber(ad.price)}</span>
          <span class="price-fiat">${ad.fiat || 'VND'}</span>
        </td>
        <td class="mono-cell">${formatNumber(ad.quantity)} ${ad.token || 'USDT'}</td>
        <td class="limit-cell">
          <span class="mono-cell">${formatNumber(ad.minAmount)} - ${formatNumber(ad.maxAmount)}</span>
          <span class="limit-fiat">${ad.fiat || 'VND'}</span>
        </td>
        <td><span class="payment-badge">${payments}</span></td>
        <td class="mono-cell">${ad.completedOrderNum || 0} / ${completedRate}</td>
        <td class="mono-cell text-muted">${ad.avgReleaseTime || '—'} phút</td>
      </tr>`;
    }).join('');

    // Pagination
    const pageKey = side === 'buy' ? 'bgMarketBuyPage' : 'bgMarketSellPage';
    const currentPage = state[pageKey];
    const hasNext = ads.length >= 10;
    if (pagEl) {
      pagEl.innerHTML = `
        <button class="btn-page" onclick="App.changeBgMarketPage('${side}', -1)" ${currentPage <= 1 ? 'disabled' : ''}>‹ Trước</button>
        <span class="page-info">Trang ${currentPage}</span>
        <button class="btn-page" onclick="App.changeBgMarketPage('${side}', 1)" ${hasNext ? '' : 'disabled'}>Sau ›</button>
      `;
    }
  }

  function switchBgMarketTab(tab) {
    state.bgMarketTab = tab;

    // 2 nút tab nằm NGOÀI #bitgetCard → chọn trực tiếp theo data-tab
    const buyBtn  = document.querySelector('[data-tab="bgBuy"]');
    const sellBtn = document.querySelector('[data-tab="bgSell"]');
    if (buyBtn)  buyBtn.classList.toggle('active', tab === 'buy');
    if (sellBtn) sellBtn.classList.toggle('active', tab === 'sell');

    // Hiện/ẩn panel tương ứng
    document.getElementById('bgBuyMarketPanel').classList.toggle('active', tab === 'buy');
    document.getElementById('bgSellMarketPanel').classList.toggle('active', tab === 'sell');

    // Nếu side này chưa có dữ liệu → tự động tải
    const ads = tab === 'buy' ? state.bgMarketBuy : state.bgMarketSell;
    if (state.bgConnected && (!ads || ads.length === 0)) {
      loadBgMarket(tab);
    }
  }

  function changeBgMarketPage(side, direction) {
    const pageKey = side === 'buy' ? 'bgMarketBuyPage' : 'bgMarketSellPage';
    const newPage = state[pageKey] + direction;
    if (newPage < 1) return;
    state[pageKey] = newPage;
    loadBgMarket(side);
  }

  async function connectBitget() {
    const apiKey = document.getElementById('bgApiKey').value.trim();
    const secretKey = document.getElementById('bgSecretKey').value.trim();
    const passphrase = document.getElementById('bgPassphrase').value.trim();
    if (!apiKey || !secretKey || !passphrase) {
      showToast('Nhập đầy đủ API Key, Secret Key, Passphrase Bitget', 'error'); return;
    }
    setLoading(true, 'bgConnectBtn');
    try {
      const r = await api.post('/api/bitget/connect', { apiKey, secretKey, passphrase });
      if (r.code === 0) {
        state.bgConnected = true;
        updateBgConnectionUI(true);
        showToast('Bitget kết nối thành công!', 'success');
        await loadBitgetAds();
        restoreBitgetPricerConfig();  // ★ khôi phục cấu hình đã lưu

        refreshPriceBoard();
      } else {
        showToast(r.msg || 'Bitget kết nối thất bại', 'error');
      }
    } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
    finally { setLoading(false, 'bgConnectBtn'); }
  }

  async function lookupBitgetAd() {
    const advId = document.getElementById('bgAdvIdInput').value.trim();
    if (!advId) { showToast('Vui lòng nhập advId', 'error'); return; }

    setLoading(true, 'bgLookupBtn');
    const resultDiv = document.getElementById('bgAdInfoResult');
    try {
      const r = await api.get(`/api/bitget/ad-info?advId=${advId}`);
      if (r.code === '00000' && r.data) {
        const ad = r.data;
        
        const total = parseFloat(ad.soldAmount || 0) + parseFloat(ad.lastAmount || 0);
        const isBuy = ad.side === 'buy';
        document.getElementById('bgAdInfoGrid').innerHTML = `
          <div><span style="color:var(--text-muted)">Ad ID:</span> <span class="mono-cell">${ad.advId}</span></div>
          <div><span style="color:var(--text-muted)">Loại:</span> <span class="side-badge ${isBuy ? 'side-buy' : 'side-sell'}">${isBuy ? 'MUA' : 'BÁN'}</span></div>
          <div><span style="color:var(--text-muted)">Coin:</span> ${ad.token}</div>
          <div><span style="color:var(--text-muted)">Fiat:</span> ${ad.fiat}</div>
          <div><span style="color:var(--text-muted)">Giá:</span> <strong style="color:${isBuy ? 'var(--green)' : 'var(--red)'}">${formatNumber(ad.price)} ${ad.fiat}</strong></div>
          <div><span style="color:var(--text-muted)">Loại giá:</span> ${ad.priceType === 'fixed' ? 'Cố định' : 'Thả nổi'}</div>
          <div><span style="color:var(--text-muted)">Còn lại:</span> ${formatNumber(ad.lastAmount)} / ${formatNumber(total)}</div>
          <div><span style="color:var(--text-muted)">Đã bán:</span> ${formatNumber(ad.soldAmount)}</div>
          <div><span style="color:var(--text-muted)">Giới hạn:</span> ${formatNumber(ad.minAmount)} - ${formatNumber(ad.maxAmount)} ${ad.fiat}</div>
          <div><span style="color:var(--text-muted)">TG thanh toán:</span> ${ad.payDuration} phút</div>
          <div><span style="color:var(--text-muted)">Doanh thu:</span> ${formatNumber(ad.turnover)} ${ad.fiat}</div>
          <div><span style="color:var(--text-muted)">TG xử lý TB:</span> ${ad.avgTime} phút</div>
          <div><span style="color:var(--text-muted)">Thanh toán:</span> ${(ad.payMethodIds || []).map(p => 'PM-' + p.payMethodId).join(', ')}</div>
          <div><span style="color:var(--text-muted)">Hiển thị:</span> ${ad.market === 'public' ? 'Công khai' : 'Riêng tư'}</div>
          ${ad.remark ? `<div style="grid-column:1/3"><span style="color:var(--text-muted)">Ghi chú:</span> ${escapeHtml(ad.remark)}</div>` : ''}
        `;
        document.getElementById('bgAdInfoRaw').textContent = JSON.stringify(ad, null, 2);
        resultDiv.style.display = 'block';
        showToast('Tra cứu thành công', 'success');
      } else {
        resultDiv.style.display = 'none';
        showToast(`Lỗi: ${r.msg || 'Không tìm thấy'}`, 'error');
      }
    } catch (err) {
      resultDiv.style.display = 'none';
      showToast('Lỗi: ' + err.message, 'error');
    } finally {
      setLoading(false, 'bgLookupBtn');
    }
  }

  async function submitBitgetUpdateAd() {
    const advId = document.getElementById('bgUpAdvId').value.trim();
    if (!advId) { showToast('advId là bắt buộc', 'error'); return; }

    const payload = { advId };

    const priceType = document.getElementById('bgUpPriceType').value;
    if (priceType) payload.priceType = priceType;

    const fields = {
      bgUpPrice: 'price',
      bgUpPremium: 'premium',
      bgUpMinAmount: 'minAmount',
      bgUpMaxAmount: 'maxAmount',
      bgUpQuantity: 'quantity',
      bgUpPayTimeLimit: 'payTimeLimit',
      bgUpRemark: 'remark',
      bgUpTradeTerms: 'tradeTerms',
    };
    for (const [id, key] of Object.entries(fields)) {
      const v = document.getElementById(id).value.trim();
      if (v) payload[key] = v;  // gửi dạng String theo docs
    }

    // payMethodIds là mảng object { payMethodId, userPayMethodId? }
    const payMethodId = document.getElementById('bgUpPayMethodId').value.trim();
    const userPayMethodId = document.getElementById('bgUpUserPayMethodId').value.trim();
    if (payMethodId) {
      const pm = { payMethodId };
      if (userPayMethodId) pm.userPayMethodId = userPayMethodId;
      payload.payMethodIds = [pm];
    }

    setLoading(true, 'bgUpdateBtn');
    const responseEl = document.getElementById('bgUpdateResponse');
    const responseText = document.getElementById('bgUpdateResponseText');
    responseEl.style.display = 'none';
    try {
      const result = await api.post('/api/bitget/ads/update', payload);
      responseEl.style.display = 'block';
      responseText.textContent = JSON.stringify(result, null, 2);
      if (result.code === '00000') {
        showToast('Cập nhật Bitget thành công!', 'success');
        await loadBitgetAds();
      } else {
        showToast(`Lỗi: ${result.msg || 'Thất bại'}`, 'error');
      }
    } catch (err) {
      responseEl.style.display = 'block';
      responseText.textContent = err.message;
      showToast('Lỗi gửi request: ' + err.message, 'error');
    } finally {
      setLoading(false, 'bgUpdateBtn');
    }
  }

  function clearBitgetUpdateForm() {
    ['bgUpAdvId','bgUpPrice','bgUpPremium','bgUpMinAmount','bgUpMaxAmount',
    'bgUpQuantity','bgUpPayTimeLimit','bgUpPayMethodId','bgUpUserPayMethodId',
    'bgUpRemark','bgUpTradeTerms'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('bgUpPriceType').value = '';
    document.getElementById('bgUpdateResponse').style.display = 'none';
  }


  async function disconnectBitget() {
    await api.post('/api/bitget/disconnect');
    state.bgConnected = false;
    state.bgAds = [];
    if (bgApTimer) { clearInterval(bgApTimer); bgApTimer = null; }
    updateBgConnectionUI(false);
    renderBgAdsTable();
    renderBgApRows();
    showToast('Đã ngắt Bitget', 'info');
  }

  function updateBgConnectionUI(connected) {
    document.getElementById('bgStatusDot').className = 'status-dot' + (connected ? ' connected' : '');
    document.getElementById('bgStatusText').textContent = connected ? 'Đã kết nối' : 'Chưa kết nối';
    document.getElementById('bgConnectBtn').style.display = connected ? 'none' : 'inline-flex';
    document.getElementById('bgDisconnectBtn').style.display = connected ? 'inline-flex' : 'none';
    if (connected) document.getElementById('bgCredentials').classList.add('locked');
    else document.getElementById('bgCredentials').classList.remove('locked');
  }

  async function loadBitgetAds() {
    if (!state.bgConnected) return;
    try {
      const r = await api.get('/api/bitget/ads');
      if (r.code === '00000') {
        state.bgAds = r.data?.items || [];
        renderBgAdsTable();
      }
    } catch (err) { showToast('Lỗi Bitget: ' + err.message, 'error'); }
  }

  function renderBgAdsTable() {
    const tbody = document.getElementById('bgAdsTableBody');
    if (!tbody) return;
    if (!state.bgAds.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8"><div class="empty-state"><p>Không có quảng cáo</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = state.bgAds.map((ad, i) => {
      const isBuy = ad.side === 'buy';
      const isPublish = ad.status === 'publish';
      const total = parseFloat(ad.soldAmount || 0) + parseFloat(ad.lastAmount || 0);
      const payments = (ad.payMethods || []).map(p => `PM-${p.payMethodId}`).join(', ') || '—';
      const createdDate = ad.createdTime ? formatDate(parseInt(ad.createdTime)) : '—';
      const statusLabel = ad.status === 'publish' ? 'Đang treo' : ad.status === 'delist' ? 'Đã gỡ' : 'Đã xóa';
      return `<tr class="ad-row ${isPublish ? '' : 'ad-closed'}" style="animation-delay:${i * 0.04}s">
        <td class="mono-cell" title="${ad.advId || ''}">${truncateId(ad.advId || '')}</td>
        <td><span class="side-badge ${isBuy ? 'side-buy' : 'side-sell'}">${isBuy ? 'MUA' : 'BÁN'}</span></td>
        <td><span class="status-badge ${isPublish ? 'status-open' : 'status-closed'}"><span class="status-indicator"></span>${statusLabel}</span></td>
        <td>${ad.token || 'USDT'}</td>
        <td class="mono-cell price-value ${isBuy ? 'price-buy' : 'price-sell'}">${formatNumber(ad.price)} ${ad.fiat || ''}</td>
        <td class="mono-cell"><span>${formatNumber(ad.lastAmount)}</span><span class="text-muted"> / ${formatNumber(total)}</span></td>
        <td><span class="payment-badge">${payments}</span></td>
        <td class="mono-cell text-muted">${createdDate}</td>
      </tr>`;
    }).join('');
  }

  function renderBgApRows() {
    const tbody = document.getElementById('bgApTableBody');
    if (!tbody) return;
    if (!state.bgApRows.length) {
      tbody.innerHTML = '<tr><td colspan="13" class="ap-empty">Chưa có dòng nào. Bấm "➕ Thêm dòng" để cấu hình.</td></tr>';
      return;
    }
    tbody.innerHTML = state.bgApRows.map(r => `
      <tr id="bg-ap-row-${r.id}">
        <td>
          <select class="ap-num-input" style="width:90px" onchange="App.bgApSetRow(${r.id},'side',this.value)">
            <option value="buy" ${r.side === 'buy' ? 'selected' : ''}>MUA</option>
            <option value="sell" ${r.side === 'sell' ? 'selected' : ''}>BÁN</option>
          </select>
        </td>
        <td><input type="text" class="ap-num-input" style="width:170px" value="${escapeHtml(r.advId)}" placeholder="advId" onchange="App.bgApSetRow(${r.id},'advId',this.value.trim())"></td>
        <td><label class="toggle"><input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="App.bgApSetRow(${r.id},'enabled',this.checked)"><span class="toggle-slider"></span></label></td>
        <td><input type="number" class="ap-num-input" style="width:110px" value="${r.searchAmount}" placeholder="Tất cả" onchange="App.bgApSetRow(${r.id},'searchAmount',this.value)"></td>
        <td>
          <div class="filter-input-unit" style="width:fit-content">
            <input type="number" class="filter-input" style="width:80px" value="${r.offset}" placeholder="mặc định" onchange="App.bgApSetRow(${r.id},'offset',this.value)">
            <span class="filter-unit">VND</span>
          </div>
        </td>
        <td><input type="number" class="ap-num-input" value="${r.priceLimit}" placeholder="${r.side === 'buy' ? 'Trần' : 'Sàn'}" onchange="App.bgApSetRow(${r.id},'priceLimit',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${r.minAmount}" placeholder="—" onchange="App.bgApSetRow(${r.id},'minAmount',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${r.maxAmount}" placeholder="—" onchange="App.bgApSetRow(${r.id},'maxAmount',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${r.quantity}" placeholder="—" onchange="App.bgApSetRow(${r.id},'quantity',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${r.refillThreshold}" placeholder="—" onchange="App.bgApSetRow(${r.id},'refillThreshold',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${r.refillQuantity}" placeholder="—" onchange="App.bgApSetRow(${r.id},'refillQuantity',this.value)"></td>
        <td><span class="ap-row-status" id="bg-ap-status-${r.id}">${escapeHtml(r.lastStatus) || '—'}</span></td>
        <td><button class="ap-job-actions btn-remove" style="padding:4px 10px;font-size:11px;border-radius:4px;border:1px solid rgba(239,68,68,0.3);background:rgba(255,255,255,0.04);color:var(--red);cursor:pointer" onclick="App.bgApRemoveRow(${r.id})">Xóa</button></td>
      </tr>
    `).join('');
  }

  function bgApAddRow() {
    state.bgApRows.push({
      id: bgApRowSeq++, side: 'buy', advId: '',
      priceLimit: '', minAmount: '', maxAmount: '', quantity: '',
      searchAmount: '', offset: '',
      refillThreshold: '', refillQuantity: '',
      enabled: false, lastStatus: ''
    });
    renderBgApRows();
  }

  function bgApRemoveRow(id) {
    state.bgApRows = state.bgApRows.filter(r => r.id !== id);
    renderBgApRows();
  }

  function bgApSetRow(id, field, value) {
    const row = state.bgApRows.find(r => r.id === id);
    if (!row) return;
    row[field] = value;
    // Đổi side → cập nhật placeholder Trần/Sàn
    if (field === 'side') renderBgApRows();
  }

  /**
   * Lấy giá tốt nhất của 1 chiều market.
   * marketSide='sell' → giá thấp nhất; marketSide='buy' → giá cao nhất.
   */
  async function bgFindBestMarketPrice(marketSide, searchAmount, selfAdvId, priceLimit, isBuyAd) {
    const amount = (searchAmount !== '' && searchAmount != null)
      ? searchAmount
      : (document.getElementById('bgFilterAmount')?.value || '');
    const params = `side=${marketSide}&token=USDT&fiat=VND&pageNum=1&limit=10${amount ? '&amount=' + amount : ''}`;
    const r = await api.get(`/api/bitget/market?${params}`);
    if (r.code !== '00000') return null;
    const ads = r.data.items;

    const hasLimit = priceLimit !== '' && priceLimit != null && !isNaN(parseFloat(priceLimit));
    const lim = hasLimit ? parseFloat(priceLimit) : null;

    // Số lượng giao dịch cần so giá (để kiểm tra ad đối thủ có gánh được không)
    const reqAmount = (searchAmount !== '' && searchAmount != null && !isNaN(parseFloat(searchAmount)))
      ? parseFloat(searchAmount)
      : 0;

    let best = null;
    for (const ad of ads) {
      if (selfAdvId && String(ad.advId) === String(selfAdvId)) continue;
      const p = parseFloat(ad.price);
      if (isNaN(p)) continue;

      // Lọc theo trần/sàn: ad MUA bỏ giá > trần; ad BÁN bỏ giá < sàn
      if (hasLimit) {
        if (isBuyAd && p > lim) continue;
        if (!isBuyAd && p < lim) continue;
      }

      // Trần giao dịch THỰC của đối thủ = min(maxAmount đã đặt, quantity còn lại × giá)
      // Khi quantity tụt mà maxAmount chưa cập nhật, quantity×price phản ánh đúng hơn.
      if (reqAmount > 0) {
        const declaredMax = parseFloat(ad.maxAmount);
        const byQty = parseFloat(ad.quantity) * p;
        let effectiveMax;
        if (!isNaN(declaredMax) && !isNaN(byQty)) effectiveMax = Math.min(declaredMax, byQty);
        else if (!isNaN(declaredMax)) effectiveMax = declaredMax;
        else if (!isNaN(byQty)) effectiveMax = byQty;
        else effectiveMax = null;

        // Nếu trần thực không gánh nổi mức giao dịch cần → bỏ qua ad này
        if (effectiveMax !== null && effectiveMax < reqAmount) continue;
      }

      if (best === null) best = p;
      else best = marketSide === 'sell' ? Math.max(best, p) : Math.min(best, p);
    }
    return best;
  }


  function bgLog(msg, type = '') {
    const log = document.getElementById('bgLog');
    if (!log) return;
    const empty = log.querySelector('.ap-log-empty');
    if (empty) empty.remove();
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    const entry = document.createElement('div');
    entry.className = 'ap-log-entry';
    entry.innerHTML = `<span class="ap-log-time">${time}</span><span class="ap-log-msg ${type}">${escapeHtml(msg)}</span>`;
    log.insertBefore(entry, log.firstChild);
    while (log.children.length > 100) log.removeChild(log.lastChild);
  }

  async function bgRunCycle() {
    const rows = state.bgApRows.filter(r => r.enabled && r.advId);
    if (!rows.length) return;

    const offsetBuy = parseFloat(document.getElementById('bgOffsetBuy').value) || 0;
    const offsetSell = parseFloat(document.getElementById('bgOffsetSell').value) || 0;

    for (const row of rows) {
      const isBuy = row.side === 'buy';
      const statusEl = document.getElementById(`bg-ap-status-${row.id}`);
      const setStatus = (msg, type) => {
        row.lastStatus = msg;
        if (statusEl) { statusEl.textContent = msg; statusEl.className = `ap-row-status${type ? ' ' + type : ''}`; }
      };

      try {
        setStatus('Đang quét...', '');

        // 1. Giá tham chiếu: BUY ad ← SELL market (giá cao nhất) ; SELL ad ← BUY market (giá thấp nhất)
        const marketSide = isBuy ? 'sell' : 'buy';
        let refPrice;
        try {
          refPrice = await bgFindBestMarketPrice(marketSide, row.searchAmount, row.advId, row.priceLimit, isBuy);
        } catch (err) {
          setStatus(`Lỗi lấy giá: ${err.message}`, 'err');
          bgLog(`[${truncateId(row.advId)}] lỗi giá market: ${err.message}`, 'error');
          continue;
        }
        if (refPrice === null) {
          setStatus('Chưa có giá market', 'warn');
          bgLog(`[${truncateId(row.advId)}] Chưa lấy được giá ${marketSide.toUpperCase()} market`, 'warn');
          continue;
        }

        // 2. Tra cứu ad hiện tại — lấy số lượng còn lại + payMethodIds
        const info = await api.get(`/api/bitget/ad-info?advId=${row.advId}`);
        if (info.code !== '00000' || !info.data) {
          setStatus(`Lỗi ad-info: ${info.msg || 'không thấy'}`, 'err');
          bgLog(`[${truncateId(row.advId)}] ad-info lỗi: ${info.msg || 'không thấy'}`, 'error');
          continue;
        }
        const ad = info.data;
        const currentPrice = parseFloat(ad.price);
        const currentAvailable = parseFloat(ad.lastAmount) || 0;  // số lượng coin còn lại

        // 3. Tính giá mới = ref + offset (per-row ghi đè global)
        const rowOffset = (row.offset !== '' && row.offset != null && !isNaN(parseFloat(row.offset)))
          ? parseFloat(row.offset)
          : (isBuy ? offsetBuy : offsetSell);
        let newPrice = refPrice + rowOffset;

        // Áp trần (BUY) / sàn (SELL)
        if (row.priceLimit !== '' && row.priceLimit != null) {
          const lim = parseFloat(row.priceLimit);
          if (!isNaN(lim)) {
            if (isBuy && newPrice > lim) newPrice = lim;
            if (!isBuy && newPrice < lim) newPrice = lim;
          }
        }
        newPrice = Math.round(newPrice);

        // 4. Refill: nếu số lượng còn lại < ngưỡng refill → đặt quantity = refill SL
        let quantity = (row.quantity !== '' && row.quantity != null) ? parseFloat(row.quantity) : currentAvailable;
        const hasRefill = row.refillThreshold !== '' && row.refillThreshold != null
                        && row.refillQuantity !== '' && row.refillQuantity != null;
        if (hasRefill) {
          const threshold = parseFloat(row.refillThreshold);
          const refillTo = parseFloat(row.refillQuantity);
          if (!isNaN(threshold) && !isNaN(refillTo) && currentAvailable < threshold) {
            quantity = refillTo;
            bgLog(`[${truncateId(row.advId)}] Refill: còn ${formatNumber(currentAvailable)} < ${formatNumber(threshold)} → SL=${formatNumber(refillTo)}`, 'warn');
          }
        }

        // 5. Kiểm tra giá đổi VÀ không cần refill thì bỏ qua. Nếu cần refill thì vẫn update dù giá giữ nguyên.
        const priceUnchanged = (newPrice === Math.round(currentPrice));
        const needRefill = hasRefill && currentAvailable < parseFloat(row.refillThreshold);
        if (priceUnchanged && !needRefill) {
          setStatus(`Giá OK: ${formatNumber(currentPrice)}`, 'ok');
          continue;
        }

        // 6. maxAmount: nếu quantity × giá > max → đặt max = quantity × giá; ngược lại giữ max người dùng nhập (lấy giá trị nhỏ hơn)
        let maxAmount = (row.maxAmount !== '' && row.maxAmount != null) ? parseFloat(row.maxAmount) : null;
        const capByQty = quantity * newPrice;
        if (maxAmount === null) {
          maxAmount = capByQty;
        } else if (maxAmount > capByQty) {
          maxAmount = capByQty;
        }
        maxAmount = Math.floor(maxAmount);

        // 7. payMethodIds — đọc lại từ chính ad-info (đúng phương thức của ad này)
        const payMethodIds = extractBgPayMethods(ad);
        if (!payMethodIds.length) {
          setStatus('Thiếu payMethodIds từ ad-info', 'err');
          bgLog(`[${truncateId(row.advId)}] ad-info không có payMethodIds — không thể update`, 'error');
          continue;
        }

        // 8. Build payload
        const payTimeLimit = isBuy ? '30' : '10';
        const payload = {
          advId: row.advId,
          priceType: 'fixed',
          price: String(newPrice),
          payTimeLimit,
          payMethodIds,
          quantity: String(quantity),
          maxAmount: String(maxAmount),
        };
        if (row.minAmount !== '' && row.minAmount != null) payload.minAmount = String(row.minAmount);

        const result = await api.post('/api/bitget/ads/update', payload);

        if (result.code === '00000') {
          setStatus(`→ ${formatNumber(newPrice)} | SL ${formatNumber(quantity)}`, 'ok');
          bgLog(`[${truncateId(row.advId)}] ${row.side.toUpperCase()} | ref ${marketSide.toUpperCase()}: ${formatNumber(refPrice)} +${rowOffset} → ${formatNumber(newPrice)} | SL=${formatNumber(quantity)} | max=${formatNumber(maxAmount)}`, 'success');
        } else {
          setStatus(`Lỗi: ${result.msg}`, 'err');
          bgLog(`[${truncateId(row.advId)}] update lỗi: ${result.msg}`, 'error');
        }
      } catch (err) {
        setStatus(`Lỗi: ${err.message}`, 'err');
        bgLog(`[${truncateId(row.advId)}] ${err.message}`, 'error');
      }
    }
  }

  function extractBgPayMethods(ad) {
    const raw = ad.payMethodIds || ad.payMethods || [];
    if (!Array.isArray(raw)) return [];
    return raw.map(p => {
      if (p == null) return null;
      // Trường hợp phần tử là chuỗi/số phẳng: ["123"]
      if (typeof p !== 'object') return { payMethodId: String(p) };
      // Trường hợp object: lấy payMethodId + userPayMethodId nếu có
      const pmId = p.payMethodId ?? p.payId ?? p.id;
      if (pmId == null) return null;
      const item = { payMethodId: String(pmId) };
      const userPm = p.userPayMethodId ?? p.userPayId ?? p.userPaymentId;
      if (userPm != null) item.userPayMethodId = String(userPm);
      return item;
    }).filter(Boolean);
  }

  function startBitgetPricer() {
    if (bgApTimer) return;
    const interval = Math.max(1, parseInt(document.getElementById('bgScanInterval').value) || 30) * 1000;
    document.getElementById('bgApBadge').textContent = '▶ Đang chạy';
    document.getElementById('bgApBadge').className = 'ap-status-badge running';
    document.getElementById('bgStartBtn').style.display = 'none';
    document.getElementById('bgStopBtn').style.display = 'inline-flex';
    bgLog(`Bitget auto-pricer bắt đầu — quét mỗi ${interval / 1000}s`, 'success');

    const loop = async () => {
      await bgRunCycle();
      if (bgApTimer !== null) bgApTimer = setTimeout(loop, interval);
    };
    bgApTimer = setTimeout(loop, 0);  // chạy ngay vòng đầu
  }

  function stopBitgetPricer() {
    if (bgApTimer) { clearTimeout(bgApTimer); bgApTimer = null; }
    document.getElementById('bgApBadge').textContent = '⏹ Đã dừng';
    document.getElementById('bgApBadge').className = 'ap-status-badge stopped';
    document.getElementById('bgStartBtn').style.display = 'inline-flex';
    document.getElementById('bgStopBtn').style.display = 'none';
    bgLog('Bitget auto-pricer đã dừng', 'warn');
  }

  async function connectBybit() {
  const apiKey = document.getElementById('byApiKey').value.trim();
  const apiSecret = document.getElementById('byApiSecret').value.trim();
  if (!apiKey || !apiSecret) { showToast('Nhập API Key và Secret', 'error'); return; }

  setLoading(true, 'byConnectBtn');
  try {
    const r = await api.post('/api/bybit/connect', { apiKey, apiSecret });
    if (r.code === 0) {
      state.byConnected = true;
      updateBybitUI(true);
      showToast('Đã kết nối Bybit', 'success');
      await loadBybitAds();
    } else {
      showToast('Lỗi: ' + (r.msg || 'Kết nối thất bại'), 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  } finally {
    setLoading(false, 'byConnectBtn');
  }
}

async function disconnectBybit() {
  await api.post('/api/bybit/disconnect');
  state.byConnected = false;
  state.byAds = [];
  updateBybitUI(false);
  showToast('Đã ngắt Bybit', 'info');
}

function updateBybitUI(connected) {
  document.getElementById('byConnStatus').textContent = connected ? 'Đã kết nối' : 'Chưa kết nối';
  document.getElementById('byConnectBtn').style.display = connected ? 'none' : 'inline-flex';
  document.getElementById('byDisconnectBtn').style.display = connected ? 'inline-flex' : 'none';
  document.getElementById('byAdsSection').style.display = connected ? 'block' : 'none';
}

async function loadBybitAds() {
  if (!state.byConnected) return;
  try {
    const r = await api.get('/api/bybit/my-ads');
    console.log('[Bybit my-ads]', r);
    if (r.ret_code === 0) {
      state.byAds = extractBybitAds(r);
      renderBybitAds();
    } else {
      showToast('Lỗi tải ads: ' + (r.ret_msg || ''), 'error');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// Bóc mảng ad từ result — chịu nhiều dạng bọc
function extractBybitAds(r) {
  const res = r.result || {};
  if (Array.isArray(res.items)) return res.items;
  if (Array.isArray(res.list)) return res.list;
  if (Array.isArray(res)) return res;
  return [];
}

function renderBybitAds() {
  const tbody = document.getElementById('byAdsBody');
  if (!state.byAds.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-muted)">Không có quảng cáo</td></tr>';
    return;
  }
  tbody.innerHTML = state.byAds.map(ad => {
    // side: 0 = MUA, 1 = BÁN
    const isBuy = Number(ad.side) === 0;
    const sideLabel = isBuy ? 'MUA' : 'BÁN';
    const sideBadge = `<span class="by-side-badge ${isBuy ? 'by-buy' : 'by-sell'}">${sideLabel}</span>`;

    // status ad: 10 = đang đăng (active). Các giá trị khác coi là ẩn/ngừng.
    const isActive = Number(ad.status) === 10;
    const adStatusBadge = `<span class="by-status-badge ${isActive ? 'by-active' : 'by-inactive'}">${isActive ? 'Đang đăng' : `Ẩn (${ad.status})`}</span>`;

    // isOnline: cờ online/offline của thương nhân (boolean riêng, độc lập với status)
    const online = ad.isOnline === true;
    const onlineBadge = `<span class="by-status-badge ${online ? 'by-online' : 'by-offline'}">
      <span class="by-dot"></span>${online ? 'Online' : 'Offline'}</span>`;

    return `<tr>
      <td class="mono-cell">${escapeHtml(String(ad.id ?? '—'))}</td>
      <td>${sideBadge}</td>
      <td>${escapeHtml(ad.tokenId ?? '—')}</td>
      <td>${escapeHtml(ad.currencyId ?? '—')}</td>
      <td class="mono-cell">${escapeHtml(String(ad.price ?? '—'))}</td>
      <td class="mono-cell">${escapeHtml(String(ad.minAmount ?? '—'))}</td>
      <td class="mono-cell">${escapeHtml(String(ad.maxAmount ?? '—'))}</td>
      <td class="mono-cell">${escapeHtml(String(ad.lastQuantity ?? ad.quantity ?? '—'))}</td>
      <td>${adStatusBadge}</td>
      <td>${onlineBadge}</td>
    </tr>`;
  }).join('');
  }

  async function testBybitMarket() {
    const body = {
      tokenId: document.getElementById('byMktToken').value.trim(),
      currencyId: document.getElementById('byMktCurrency').value.trim(),
      side: document.getElementById('byMktSide').value,
      size: document.getElementById('byMktSize').value || '10',
    };
    setLoading(true, 'byMktBtn');
    const box = document.getElementById('byMktResponse');
    const txt = document.getElementById('byMktResponseText');
    try {
      const r = await api.post('/api/bybit/online-ads', body);
      box.style.display = 'block';
      txt.textContent = JSON.stringify(r, null, 2);
      if (r.ret_code !== 0) showToast('Lỗi: ' + (r.ret_msg || ''), 'error');
    } catch (err) {
      box.style.display = 'block'; txt.textContent = err.message;
      showToast('Lỗi: ' + err.message, 'error');
    } finally { setLoading(false, 'byMktBtn'); }
  }

  // Nạp ad hiện tại từ danh sách my-ads vào form update (điền đủ field bắt buộc)
  function loadBybitAdIntoForm() {
    const id = document.getElementById('byUpId').value.trim();
    if (!id) { showToast('Nhập Ad ID trước', 'error'); return; }
    const ad = (state.byAds || []).find(a => String(a.id) === id);
    if (!ad) { showToast('Không thấy ad trong danh sách. Bấm "Tải lại" ở mục Quảng cáo của tôi trước.', 'error'); return; }
    document.getElementById('byUpPriceType').value = String(ad.priceType ?? '0');
    document.getElementById('byUpPrice').value = ad.price ?? '';
    document.getElementById('byUpPremium').value = ad.premium ?? '';
    document.getElementById('byUpQuantity').value = ad.quantity ?? ad.lastQuantity ?? '';
    document.getElementById('byUpPayPeriod').value = ad.paymentPeriod ?? 15;
    document.getElementById('byUpMin').value = ad.minAmount ?? '';
    document.getElementById('byUpMax').value = ad.maxAmount ?? '';
    document.getElementById('byUpPaymentIds').value = (ad.payments || []).join(',');
    document.getElementById('byUpRemark').value = ad.remark ?? '';
    showToast('Đã nạp ad vào form', 'success');
  }

  async function loadBybitPayments() {
    const box = document.getElementById('byUpResponse');
    const txt = document.getElementById('byUpResponseText');
    try {
      const r = await api.get('/api/bybit/payments');
      box.style.display = 'block';
      txt.textContent = JSON.stringify(r, null, 2);
      showToast('Xem danh sách payment phía dưới — dùng field "id" làm Payment ID', 'info');
    } catch (err) {
      box.style.display = 'block'; txt.textContent = err.message;
    }
  }

  async function submitBybitUpdate() {
    const id = document.getElementById('byUpId').value.trim();
    if (!id) { showToast('Ad ID là bắt buộc', 'error'); return; }

    const paymentIds = document.getElementById('byUpPaymentIds').value
      .split(',').map(s => s.trim()).filter(Boolean);

    // Mọi field đều bắt buộc theo tài liệu Bybit — gửi đủ bộ
    const payload = {
      id,
      priceType: document.getElementById('byUpPriceType').value,
      premium: document.getElementById('byUpPremium').value.trim(),
      price: document.getElementById('byUpPrice').value.trim(),
      minAmount: document.getElementById('byUpMin').value.trim(),
      maxAmount: document.getElementById('byUpMax').value.trim(),
      remark: document.getElementById('byUpRemark').value,
      tradingPreferenceSet: {},
      paymentIds,
      actionType: document.getElementById('byUpActionType').value,
      quantity: document.getElementById('byUpQuantity').value.trim(),
      paymentPeriod: document.getElementById('byUpPayPeriod').value.trim(),
    };

    setLoading(true, 'byUpBtn');
    const box = document.getElementById('byUpResponse');
    const txt = document.getElementById('byUpResponseText');
    try {
      const r = await api.post('/api/bybit/ads/update', payload);
      box.style.display = 'block';
      txt.textContent = JSON.stringify(r, null, 2);
      if (r.ret_code === 0) { showToast('Cập nhật thành công!', 'success'); await loadBybitAds(); }
      else showToast('Lỗi: ' + (r.ret_msg || ''), 'error');
    } catch (err) {
      box.style.display = 'block'; txt.textContent = err.message;
      showToast('Lỗi: ' + err.message, 'error');
    } finally { setLoading(false, 'byUpBtn'); }
  }

  // ─── Kết nối / Ngắt kết nối ──────────────────────────

  async function connect() {
    const apiKey = document.getElementById('apiKey').value.trim();
    const secretKey = document.getElementById('secretKey').value.trim();
    const apiHost = document.getElementById('apiHost').value;

    if (!apiKey || !secretKey) {
      showToast('Vui lòng nhập API Key và Secret Key', 'error');
      return;
    }

    setLoading(true, 'connectBtn');
    try {
      const result = await api.post('/api/connect', { apiKey, secretKey, apiHost });

      if (result.code === 0) {
        state.connected = true;
        updateConnectionUI(true, apiHost);
        showToast('Kết nối thành công!', 'success');
        await loadMyAds();
        restoreMexcPricerConfig();   // ★ khôi phục cấu hình đã lưu
        renderAutoPricerTable();     // ★ render lại để áp cấu hình
        await loadMarketAds('BUY');
        await loadMarketAds('SELL');
      } else {
        showToast(result.msg || 'Kết nối thất bại', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối: ' + err.message, 'error');
    } finally {
      setLoading(false, 'connectBtn');
    }
  }

  async function disconnect() {
    await api.post('/api/disconnect');
    state.connected = false;
    state.buyAds = [];
    state.sellAds = [];
    state.myAds = [];
    state.myAdsFiltered = [];
    updateConnectionUI(false);
    renderAdsTable('buy');
    renderAdsTable('sell');
    renderMyAdsTable();
    showToast('Đã ngắt kết nối', 'info');
  }

  // ─── Kết nối phụ ─────────────────────────────────────

  async function connectSecondary() {
    const apiKey = document.getElementById('apiKey2').value.trim();
    const secretKey = document.getElementById('secretKey2').value.trim();
    const apiHost = document.getElementById('apiHost2').value;

    if (!apiKey || !secretKey) {
      showToast('Vui lòng nhập API Key và Secret Key phụ', 'error');
      return;
    }

    setLoading(true, 'connectBtn2');
    try {
      const result = await api.post('/api/connect/secondary', { apiKey, secretKey, apiHost });

      if (result.code === 0) {
        state.secondaryConnected = true;
        updateSecondaryConnectionUI(true, apiHost);
        showToast('Kết nối phụ thành công!', 'success');
        await loadMarketAds('BUY');
        await loadMarketAds('SELL');

        refreshPriceBoard();
      } else {
        showToast(result.msg || 'Kết nối phụ thất bại', 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối phụ: ' + err.message, 'error');
    } finally {
      setLoading(false, 'connectBtn2');
    }
  }

  async function disconnectSecondary() {
    await api.post('/api/disconnect/secondary');
    state.secondaryConnected = false;
    state.buyAdsRaw = []; state.buyAds = [];
    state.sellAdsRaw = []; state.sellAds = [];
    state.buyPage = { startPage: 1, fetchedUpTo: 1, total: 1, history: [] };
    state.sellPage = { startPage: 1, fetchedUpTo: 1, total: 1, history: [] };
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    updateSecondaryConnectionUI(false);
    renderAdsTable('buy');
    renderAdsTable('sell');
    showToast('Đã ngắt kết nối phụ', 'info');
  }

  function updateSecondaryConnectionUI(connected, host) {
    const statusDot = document.getElementById('secondaryStatusDot');
    const statusText = document.getElementById('secondaryStatusText');
    const connectBtn = document.getElementById('connectBtn2');
    const disconnectBtn = document.getElementById('disconnectBtn2');
    const credSection = document.getElementById('secondaryCredentialInputs');

    if (connected) {
      statusDot.className = 'status-dot connected';
      statusText.textContent = `Đã kết nối · ${host}`;
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'inline-flex';
      credSection.classList.add('locked');
    } else {
      statusDot.className = 'status-dot';
      statusText.textContent = 'Chưa kết nối';
      connectBtn.style.display = 'inline-flex';
      disconnectBtn.style.display = 'none';
      credSection.classList.remove('locked');
    }
  }

  // ═══════════════════════════════════════════════════════
  // MY ADS — Quảng cáo của tôi
  // ═══════════════════════════════════════════════════════

  async function loadMyAds(_page = 1) {
    if (!state.connected) return;

    setMyAdsLoading(true);

    try {
      const result = await api.get(
        `/api/my/ads?merchantId=27939138&advStatus=`
      );

      console.log('[My Ads] API response:', result);

      if (result.code === 0) {
        state.myAds = result.data || [];
        state.myAdsPage = {
          current: result.page?.currPage || 1,
          total: result.page?.totalPage || 1,
        };
        state.myAdvNos = new Set(state.myAds.map(a => a.advNo || a.davNo || '').filter(Boolean));
        applyMyAdsFilter();
        renderAutoPricerTable();
      } else {
        showToast(`Lỗi lấy ads cá nhân: ${result.msg}`, 'error');
      }
    } catch (err) {
      showToast(`Lỗi: ${err.message}`, 'error');
    } finally {
      setMyAdsLoading(false);
    }
  }

  function filterMyAds(filter) {
    state.myAdsFilter = filter;
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === filter);
    });
    applyMyAdsFilter();
  }

  function applyMyAdsFilter() {
    if (state.myAdsFilter === 'ALL') {
      state.myAdsFiltered = [...state.myAds];
    } else {
      state.myAdsFiltered = state.myAds.filter(ad => {
        const status = (ad.advStatus || '').toUpperCase();
        return status === state.myAdsFilter;
      });
    }
    renderMyAdsTable();
  }

  function renderMyAdsTable() {
    const ads = state.myAdsFiltered;
    const container = document.getElementById('myAdsTableBody');
    if (!container) return;

    updateMyAdsCounters();

    if (!ads || ads.length === 0) {
      container.innerHTML = `
        <tr class="empty-row">
          <td colspan="10">
            <div class="empty-state">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
              </svg>
              <p>${state.connected ? 'Không có quảng cáo nào' : 'Kết nối để xem quảng cáo của bạn'}</p>
            </div>
          </td>
        </tr>`;
      return;
    }

    container.innerHTML = ads.map((ad, i) => {
      const isOpen = (ad.advStatus || '').toUpperCase() === 'OPEN';
      const isBuy = (ad.side || '').toUpperCase() === 'BUY';
      const createdDate = ad.createTime ? formatDate(ad.createTime) : '—';
      const quantity = ad.quantity || (ad.initAmount && ad.price ? (ad.initAmount / ad.price).toFixed(4) : '—');
      const paymentNames = (ad.paymentInfo || [])
        .map(p => p.bankName || getPayMethodName(String(p.payMethod)))
        .join(', ') || getPayMethodName(ad.payMethod);

      return `
        <tr class="ad-row my-ad-row ${isOpen ? '' : 'ad-closed'}" style="animation-delay: ${i * 0.04}s">
          <td class="mono-cell" title="${ad.advNo || ad.davNo || ''}">
            ${truncateId(ad.advNo || ad.davNo || '—')}
          </td>
          <td>
            <span class="side-badge ${isBuy ? 'side-buy' : 'side-sell'}">
              ${isBuy ? 'MUA' : 'BÁN'}
            </span>
          </td>
          <td>
            <span class="status-badge ${isOpen ? 'status-open' : 'status-closed'}">
              <span class="status-indicator"></span>
              ${isOpen ? 'Đang mở' : 'Đã đóng'}
            </span>
          </td>
          <td>${ad.coinName || 'USDT'}</td>
          <td class="mono-cell price-value ${isBuy ? 'price-buy' : 'price-sell'}">
            ${formatNumber(ad.price)}
          </td>
          <td class="mono-cell">
            <span class="${isOpen ? '' : 'text-muted'}">${formatNumber(ad.availableQuantity)}</span>
            <span class="text-muted"> / ${formatNumber(quantity)}</span>
          </td>
          <td class="mono-cell">
            ${formatNumber(ad.minSingleTransAmount)} - ${formatNumber(ad.maxSingleTransAmount)}
          </td>
          <td>${ad.fiatUnit || '—'}</td>
          <td>
            <span class="payment-badge">${paymentNames || 'N/A'}</span>
          </td>
          <td class="mono-cell text-muted">${createdDate}</td>
        </tr>`;
    }).join('');
  }

  function updateMyAdsCounters() {
    const all = state.myAds.length;
    const open = state.myAds.filter(a => (a.advStatus || '').toUpperCase() === 'OPEN').length;
    const closed = state.myAds.filter(a => (a.advStatus || '').toUpperCase() === 'CLOSE').length;

    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(chip => {
      const filter = chip.dataset.filter;
      const count = filter === 'ALL' ? all : filter === 'OPEN' ? open : closed;
      if (state.connected && all > 0) {
        const label = chip.textContent.replace(/\s*\(\d+\)/, '').trim();
        chip.textContent = `${label} (${count})`;
      }
    });
  }

  function setMyAdsLoading(loading) {
    const wrapper = document.getElementById('myAdsTableWrapper');
    if (!wrapper) return;
    wrapper.classList.toggle('my-ads-loading', loading);
  }

  async function changeMyAdsPage(direction) {
    const newPage = state.myAdsPage.current + direction;
    if (newPage < 1 || newPage > state.myAdsPage.total) return;
    await loadMyAds(newPage);
  }

  // ═══════════════════════════════════════════════════════
  // MARKET ADS — Quảng cáo trên thị trường
  // ═══════════════════════════════════════════════════════

  async function loadMarketAds(side, startPage = 1, pushHistory = false) {
    if (!state.secondaryConnected) return;

    const MIN_FILTERED = 10;
    const fiatUnit = document.getElementById('fiatFilter')?.value || state.fiatUnit;
    state.fiatUnit = fiatUnit;

    const tabKey = side === 'BUY' ? 'buy' : 'sell';
    const pageState = state[`${tabKey}Page`];

    setTableLoading(tabKey, true);

    try {
      if (pushHistory) {
        pageState.history.push(pageState.startPage);
      }

      let accumulatedRaw = [];
      let currentPage = startPage;
      let totalPages = 1;

      do {
        const result = await api.get(
          `/api/market/ads?side=${side}&fiatUnit=${fiatUnit}&page=${currentPage}&coinId=128f589271cb4951b03e71e6323eb7be&blockTrade=true&allowTrade=true&countryCode=VN`
        );

        if (result.code !== 0) {
          showToast(`Lỗi lấy dữ liệu ${side} trang ${currentPage}: ${result.msg}`, 'error');
          break;
        }

        const pageData = result.data || [];
        totalPages = result.page?.totalPage || 1;
        accumulatedRaw = accumulatedRaw.concat(pageData);

        state[`${tabKey}AdsRaw`] = accumulatedRaw;
        applyMarketFilters(tabKey);

        if (state[`${tabKey}Ads`].length >= MIN_FILTERED || currentPage >= totalPages) break;

        currentPage++;
      } while (true);

      state[`${tabKey}Page`] = {
        history: pageState.history,
        startPage,
        fetchedUpTo: currentPage,
        total: totalPages,
      };

    } catch (err) {
      showToast(`Lỗi: ${err.message}`, 'error');
    } finally {
      setTableLoading(tabKey, false);
      renderAdsTable(tabKey);
    }
  }

  function applyMarketFilters(tabKey) {
    const raw = state[`${tabKey}AdsRaw`] || [];
    const { onlineMinutes, amount } = state.marketFilters;
    const now = Date.now();

    state[`${tabKey}Ads`] = raw.filter(ad => {
      const merchant = ad.merchant || {};

      if (onlineMinutes > 0) {
        const lastOnline = merchant.lastOnlineTime;
        if (!lastOnline) return false;
        const diffMin = (now - lastOnline) / 60000;
        if (diffMin > onlineMinutes) return false;
      }

      if (amount > 0) {
        const min = parseFloat(ad.minSingleTransAmount) || 0;
        const max = parseFloat(ad.maxSingleTransAmount) || Infinity;
        if (amount < min || amount > max) return false;
      }

      return true;
    });
  }

  function updateMarketFilters() {
    const onlineMinutes = parseFloat(document.getElementById('filterOnlineMinutes').value) || 0;
    const amount = parseFloat(document.getElementById('filterAmount').value) || 0;
    const autoRefreshSec = parseInt(document.getElementById('filterAutoRefresh').value) || 0;

    state.marketFilters = { onlineMinutes, amount, autoRefreshSec };

    const fiat = document.getElementById('fiatFilter')?.value || state.fiatUnit;
    const unitEl = document.getElementById('filterAmountUnit');
    if (unitEl) unitEl.textContent = fiat;

    applyMarketFilters('buy');
    applyMarketFilters('sell');
    renderAdsTable('buy');
    renderAdsTable('sell');

    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if (autoRefreshSec > 0) {
      autoRefreshTimer = setInterval(async () => {
        await loadMarketAds('BUY', state.buyPage.current);
        await loadMarketAds('SELL', state.sellPage.current);
      }, autoRefreshSec * 1000);
    }

    updateFilterStatus();
    showToast('Đã cập nhật thông số', 'success');
  }

  function updateFilterStatus() {
    const el = document.getElementById('filterStatus');
    if (!el) return;
    const { onlineMinutes, amount, autoRefreshSec } = state.marketFilters;
    const parts = [];
    if (onlineMinutes > 0) parts.push(`Online ≤ ${onlineMinutes} phút`);
    if (amount > 0) parts.push(`Số lượng: ${formatNumber(amount)}`);
    if (autoRefreshSec > 0) parts.push(`Làm mới: ${autoRefreshSec}s`);
    el.textContent = parts.length > 0 ? parts.join(' · ') : '';
    el.style.display = parts.length > 0 ? 'block' : 'none';
  }

  async function refreshAds() {
    const side = state.currentTab === 'buy' ? 'BUY' : 'SELL';
    const tabKey = state.currentTab;
    state[`${tabKey}Page`].history = [];
    await loadMarketAds(side, 1, false);
  }

  async function changePage(direction) {
    const tabKey = state.currentTab;
    const pageState = state[`${tabKey}Page`];
    const side = tabKey === 'buy' ? 'BUY' : 'SELL';

    if (direction > 0) {
      if (pageState.fetchedUpTo >= pageState.total) return;
      await loadMarketAds(side, pageState.fetchedUpTo + 1, true);
    } else {
      if (pageState.history.length === 0) return;
      const prevStart = pageState.history.pop();
      await loadMarketAds(side, prevStart, false);
    }
  }

  // ─── Render giao diện Market Ads ─────────────────────

  function renderAdsTable(tabKey) {
    const ads = state[`${tabKey}Ads`];
    const container = document.getElementById(`${tabKey}TableBody`);
    const pageInfo = state[`${tabKey}Page`];

    if (!container) return;

    if (!ads || ads.length === 0) {
      container.innerHTML = `
        <tr class="empty-row">
          <td colspan="7">
            <div class="empty-state">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
              <p>${state.connected ? 'Không có quảng cáo nào' : 'Kết nối để xem quảng cáo'}</p>
            </div>
          </td>
        </tr>`;
      updatePagination(tabKey, pageInfo);
      return;
    }

    container.innerHTML = ads.map((ad, i) => {
      const merchant = ad.merchant || {};
      const stats = ad.merchantStatistics || {};
      const completionRate = stats.completeRate
        ? (parseFloat(stats.completeRate) * 100).toFixed(1)
        : '0';
      const totalOrders = (stats.totalBuyCount || 0) + (stats.totalSellCount || 0);

      return `
        <tr class="ad-row" style="animation-delay: ${i * 0.05}s">
          <td class="merchant-cell">
            <div class="merchant-info">
              <span class="merchant-name">${escapeHtml(merchant.nickName || 'N/A')}</span>
              <span class="merchant-meta">
                ${totalOrders} lệnh · ${completionRate}% hoàn thành
              </span>
            </div>
          </td>
          <td class="price-cell">
            <span class="price-value ${tabKey === 'buy' ? 'price-buy' : 'price-sell'}">
              ${formatNumber(ad.price)}
            </span>
            <span class="price-fiat">${ad.fiatUnit || ''}</span>
          </td>
          <td class="quantity-cell">
            <span>${formatNumber(ad.availableQuantity)} ${ad.coinName || 'USDT'}</span>
          </td>
          <td class="limit-cell">
            <span>${formatNumber(ad.minSingleTransAmount)} - ${formatNumber(ad.maxSingleTransAmount)}</span>
            <span class="limit-fiat">${ad.fiatUnit || ''}</span>
          </td>
          <td class="payment-cell">
            <span class="payment-badge">${getPayMethodName(ad.payMethod)}</span>
          </td>
          <td class="time-cell">
            <span>${ad.payTimeLimit || 15} phút</span>
          </td>
          <td class="action-cell">
            <button class="btn-trade btn-trade-${tabKey}" onclick="App.viewAd('${ad.advNo}')">
              ${tabKey === 'buy' ? 'Mua' : 'Bán'}
            </button>
          </td>
        </tr>`;
    }).join('');

    updatePagination(tabKey, pageInfo);
  }

  function updatePagination(tabKey, pageInfo) {
    const el = document.getElementById(`${tabKey}Pagination`);
    if (!el) return;

    const hasPrev = pageInfo.history && pageInfo.history.length > 0;
    const hasNext = pageInfo.fetchedUpTo < pageInfo.total;
    const filteredCount = state[`${tabKey}Ads`].length;

    const pageLabel = pageInfo.startPage < pageInfo.fetchedUpTo
      ? `Trang ${pageInfo.startPage}–${pageInfo.fetchedUpTo} / ${pageInfo.total}`
      : `Trang ${pageInfo.startPage} / ${pageInfo.total}`;

    el.innerHTML = `
      <button class="btn-page" onclick="App.changePage(-1)" ${hasPrev ? '' : 'disabled'}>
        ‹ Trước
      </button>
      <span class="page-info">${pageLabel} · ${filteredCount} kết quả</span>
      <button class="btn-page" onclick="App.changePage(1)" ${hasNext ? '' : 'disabled'}>
        Sau ›
      </button>
    `;
  }

  function switchTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `${tab}Panel`);
    });
  }

  function updateConnectionUI(connected, host) {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const connectBtn = document.getElementById('connectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const credSection = document.getElementById('credentialInputs');

    if (connected) {
      statusDot.className = 'status-dot connected';
      statusText.textContent = `Đã kết nối · ${host}`;
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'inline-flex';
      credSection.classList.add('locked');
    } else {
      statusDot.className = 'status-dot';
      statusText.textContent = 'Chưa kết nối';
      connectBtn.style.display = 'inline-flex';
      disconnectBtn.style.display = 'none';
      credSection.classList.remove('locked');
    }
  }

  // ─── Hàm tiện ích (Helpers) ──────────────────────────

  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span>
      <span>${message}</span>
    `;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function setLoading(loading, btnId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
  }

  function setTableLoading(tabKey, loading) {
    const panel = document.getElementById(`${tabKey}Panel`);
    if (!panel) return;
    panel.classList.toggle('table-loading', loading);
  }

  function formatNumber(num) {
    if (!num && num !== 0) return '—';
    const n = parseFloat(num);
    if (isNaN(n)) return num;
    return n.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(2);
    const hour = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hour}:${min}`;
  }

  function truncateId(id) {
    if (!id || id.length <= 12) return id;
    return id.slice(0, 4) + '...' + id.slice(-4);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function getPayMethodName(methodStr) {
    if (!methodStr) return 'N/A';
    const methods = {
      '1': 'Ngân hàng',
      '2': 'Momo',
      '3': 'ZaloPay',
      '4': 'VNPAY',
      '5': 'Tiền mặt',
    };
    return methodStr.split(',').map(m => methods[m.trim()] || `PM-${m.trim()}`).join(', ');
  }

  function viewAd(advNo) {
    showToast(`Chi tiết quảng cáo: ${advNo}`, 'info');
  }

  function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
  }

  // ═══════════════════════════════════════════════════════
  // AUTO-PRICER — Tự động chỉnh giá
  // ═══════════════════════════════════════════════════════

  let apTimer = null;

  function renderAutoPricerTable() {
    const tbody = document.getElementById('apTableBody');
    if (!tbody) return;

    const ads = state.myAds;
    if (!ads || ads.length === 0) {
      tbody.innerHTML = '<tr><td colspan="14" class="ap-empty">Kết nối API chính và tải quảng cáo để cấu hình</td></tr>';
      return;
    }

    tbody.innerHTML = ads.map(ad => {
      const advNo = ad.advNo || ad.davNo || '';
      const isBuy = (ad.side || '').toUpperCase() === 'BUY';

      if (!state.apConfigs[advNo]) {
        state.apConfigs[advNo] = {
          enabled: false,
          amount: '',
          onlineMinutes: 30,
          offset: isBuy ? -50 : 50,
          priceLimit: '',
          refillThreshold: '',
          refillQuantity: '',
          minTrans: ad.minSingleTransAmount || '',
          maxTrans: ad.maxSingleTransAmount || '',
          userAllTradeCountMin: 0,
          userAllTradeCountMax: 0,
          filterMaxSingleTransAmount: 0,
          lastStatus: '',
        };
      }
      const c = state.apConfigs[advNo];

      return `
        <tr id="ap-row-${advNo}">
          <td>
            <div style="display:flex;flex-direction:column;gap:2px">
              <span class="mono-cell" style="font-size:11px">${truncateId(advNo)}</span>
              <span class="side-badge ${isBuy ? 'side-buy' : 'side-sell'}" style="font-size:10px">${isBuy ? 'BUY' : 'SELL'}</span>
            </div>
          </td>
          <td>
            <label class="toggle">
              <input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="App.apToggle('${advNo}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
          </td>
          <td><input type="number" class="ap-num-input" value="${c.amount}" placeholder="—" onchange="App.apSetCfg('${advNo}','amount',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.onlineMinutes}" placeholder="∞" onchange="App.apSetCfg('${advNo}','onlineMinutes',this.value)"></td>
          <td>
            <div class="filter-input-unit" style="width:fit-content">
              <input type="number" class="filter-input" style="width:70px" value="${c.offset}" onchange="App.apSetCfg('${advNo}','offset',this.value)">
              <span class="filter-unit">VND</span>
            </div>
          </td>
          <td><input type="number" class="ap-num-input" value="${c.priceLimit}" placeholder="${isBuy ? 'Trần' : 'Sàn'}" onchange="App.apSetCfg('${advNo}','priceLimit',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.refillThreshold}" placeholder="—" onchange="App.apSetCfg('${advNo}','refillThreshold',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.refillQuantity}" placeholder="—" onchange="App.apSetCfg('${advNo}','refillQuantity',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.minTrans}" placeholder="—" onchange="App.apSetCfg('${advNo}','minTrans',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.maxTrans}" placeholder="—" onchange="App.apSetCfg('${advNo}','maxTrans',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.userAllTradeCountMin}" placeholder="—" onchange="App.apSetCfg('${advNo}','userAllTradeCountMin',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.userAllTradeCountMax}" placeholder="—" onchange="App.apSetCfg('${advNo}','userAllTradeCountMax',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.filterMaxSingleTransAmount}" placeholder="—" onchange="App.apSetCfg('${advNo}','filterMaxSingleTransAmount',this.value)"></td>
          <td><span class="ap-row-status" id="ap-status-${advNo}">${c.lastStatus || '—'}</span></td>
        </tr>`;
    }).join('');
  }

  function apToggle(advNo, enabled) {
    if (!state.apConfigs[advNo]) return;
    state.apConfigs[advNo].enabled = enabled;
  }

  function apSetCfg(advNo, field, value) {
    if (!state.apConfigs[advNo]) return;
    const num = parseFloat(value);
    state.apConfigs[advNo][field] = isNaN(num) ? value : num;
  }

  function apLog(msg, type = '') {
    const log = document.getElementById('apLog');
    if (!log) return;
    const empty = log.querySelector('.ap-log-empty');
    if (empty) empty.remove();

    const now = new Date();
    const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    const entry = document.createElement('div');
    entry.className = 'ap-log-entry';
    entry.innerHTML = `<span class="ap-log-time">${time}</span><span class="ap-log-msg ${type}">${escapeHtml(msg)}</span>`;
    log.insertBefore(entry, log.firstChild);

    while (log.children.length > 200) log.removeChild(log.lastChild);
  }

  function clearAutoPricerLog() {
    const log = document.getElementById('apLog');
    if (log) log.innerHTML = '<div class="ap-log-empty">Chưa có hoạt động nào</div>';
  }

  function updateApStatusUI(running) {
    const badge = document.getElementById('apStatusBadge');
    const startBtn = document.getElementById('apStartBtn');
    const stopBtn  = document.getElementById('apStopBtn');
    if (!badge) return;
    if (running) {
      badge.textContent = '▶ Đang chạy';
      badge.className = 'ap-status-badge running';
      startBtn.style.display = 'none';
      stopBtn.style.display  = 'inline-flex';
    } else {
      badge.textContent = '⏹ Đã dừng';
      badge.className = 'ap-status-badge stopped';
      startBtn.style.display = 'inline-flex';
      stopBtn.style.display  = 'none';
    }
  }

  function setApRowStatus(advNo, msg, type) {
    const el = document.getElementById(`ap-status-${advNo}`);
    if (!el) return;
    el.textContent = msg;
    el.className = `ap-row-status${type ? ' ' + type : ''}`;
    if (state.apConfigs[advNo]) state.apConfigs[advNo].lastStatus = msg;
  }

  /**
   * Lấy giá tốt nhất từ market với các điều kiện lọc.
   *
   * ★ MỚI: Thêm lọc theo whitelist — bỏ qua ads có ad.merchant.nickName
   *   nằm trong state.whitelist (so sánh case-insensitive).
   *
   * Bỏ qua ads của chính mình (state.myAdvNos).
   * BUY → giá cao nhất; SELL → giá thấp nhất.
   */
  async function apFindBestPrice(side, amount, fiatUnit = 'VND', limit, extraFilters = {}) {
    const now = Date.now();
    let page = 1;
    let bestPrice = null;

    // ★ MỚI: Chuẩn bị whitelist set để tra cứu nhanh (lowercase)
    const whitelistSet = new Set(state.whitelist.map(n => n.toLowerCase()));

    while (page <= 5) {
      const amountParam = amount > 0 ? `&amount=${amount}` : '';
      const result = await api.get(
        `/api/market/ads?side=${side}&fiatUnit=${fiatUnit}&page=${page}&coinId=128f589271cb4951b03e71e6323eb7be&blockTrade=true&allowTrade=true&countryCode=VN${amountParam}`
      );
      if (result.code !== 0) break;

      const ads = result.data || [];
      if (ads.length === 0) break;

      for (const ad of ads) {
        // Bỏ qua ads của mình
        if (state.myAdvNos.has(ad.advNo)) continue;

        const price = parseFloat(ad.price);
        if (isNaN(price)) continue;

        // ★ MỚI: Bỏ qua thương nhân trong whitelist
        const merchantName = (ad.merchant?.nickName || '').toLowerCase();
        if (merchantName && whitelistSet.has(merchantName)) {
          continue;
        }

        // Lọc online
        if (extraFilters.onlineMinutes > 0) {
          const lastOnline = ad.merchant?.lastOnlineTime;
          if (!lastOnline || (now - lastOnline) / 60000 > extraFilters.onlineMinutes) continue;
        }

        if (extraFilters.userAllTradeCountMin > 0 && ad.userAllTradeCountMin < extraFilters.userAllTradeCountMin) {
          continue;
        }

        if (extraFilters.userAllTradeCountMax > 0 && ad.userAllTradeCountMax < extraFilters.userAllTradeCountMax) {
          continue;
        }

        if (extraFilters.maxSingleTransAmount > 0 && ad.maxSingleTransAmount < extraFilters.maxSingleTransAmount) {
          continue;
        }

        // Lọc theo trần/sàn giá rồi cập nhật bestPrice
        if (side === 'BUY') {
          if (limit && price > parseFloat(limit)) continue;
          if (bestPrice === null || price > bestPrice) bestPrice = price;
        } else {
          if (limit && price < parseFloat(limit)) continue;
          if (bestPrice === null || price < bestPrice) bestPrice = price;
        }
      }
      
      page++;
    }

    return bestPrice;
  }

  /**
   * 1 vòng quét: duyệt qua tất cả ads đã bật, tìm giá tốt nhất, cập nhật nếu cần.
   */
  async function apRunCycle() {
    const ads = state.myAds;
    if (!ads || ads.length === 0) return;

    for (const ad of ads) {
      const advNo = ad.advNo || ad.davNo || '';
      const cfg = state.apConfigs[advNo];
      if (!cfg || !cfg.enabled) continue;

      const isBuy = (ad.side || '').toUpperCase() === 'BUY';
      const side  = isBuy ? 'BUY' : 'SELL';
      const fiat  = ad.fiatUnit || 'VND';

      setApRowStatus(advNo, 'Đang quét...', '');

      try {
        // 1. Tìm giá tốt nhất với đầy đủ điều kiện lọc
        const bestPrice = await apFindBestPrice(
          side,
          parseFloat(cfg.amount) || 0,
          fiat,
          cfg.priceLimit,
          {
            onlineMinutes: cfg.onlineMinutes || 0,
            userAllTradeCountMin: cfg.userAllTradeCountMin || 0,
            userAllTradeCountMax: cfg.userAllTradeCountMax || 0,
            maxSingleTransAmount: cfg.filterMaxSingleTransAmount || 0,
          }
        );
        console.log("apRunCycle best price " + bestPrice);

        if (bestPrice === null) {
          setApRowStatus(advNo, 'Không tìm được giá', 'warn');
          apLog(`[${truncateId(advNo)}] Không tìm được giá tốt nhất trong khung`, 'warn');
          continue;
        }

        // 2. Tính giá mới = bestPrice + offset
        let newPrice = bestPrice + (parseFloat(cfg.offset) || 0);

        // 3. Áp trần / sàn
        if (cfg.priceLimit) {
          const lim = parseFloat(cfg.priceLimit);
          if (isBuy  && newPrice > lim) newPrice = lim;
          if (!isBuy && newPrice < lim) newPrice = lim;
        }

        newPrice = Math.round(newPrice);
        const currentPrice = parseFloat(ad.price);

        // 4. Chỉ update khi giá thay đổi
        if (newPrice === currentPrice) {
          setApRowStatus(advNo, `Giá OK: ${formatNumber(currentPrice)}`, 'ok');
          continue;
        }

        // 5. Build payload update
        const payload = {
          advNo,
          advStatus: 'OPEN',
          price: newPrice,
          side,
          fiatUnit: fiat,
          coinId: ad.coinId || '128f589271cb4951b03e71e6323eb7be',
          payTimeLimit: ad.payTimeLimit,
          initQuantity: ad.availableQuantity,
          minSingleTransAmount: cfg.minTrans,
          maxSingleTransAmount: cfg.maxTrans,
          frozenQuantity: ad.frozenQuantity,
          payMethod: 1799581,
          countryCode: 'VN',
          kycLevel: 'PRIMARY',
        };

        // 6. Refill nếu số lượng khả dụng thấp hơn ngưỡng
        if (cfg.refillThreshold && cfg.refillQuantity) {
          const avail = parseFloat(ad.availableQuantity) || 0;
          console.log("Check avaiable : " + avail + " " + cfg.refillThreshold);
          if (avail < parseFloat(cfg.refillThreshold)) {
            payload.initQuantity = avail;
            payload.supplyQuantity = parseFloat(cfg.refillQuantity);
            apLog(`[${truncateId(advNo)}] Refill: ${avail} < ${cfg.refillThreshold} → set initQuantity=${cfg.refillQuantity}`, 'warn');
          }
        }

        console.log(payload.maxSingleTransAmount + " " + payload.initQuantity + " " + payload.frozenQuantity + " " + payload.price);
        if (payload.maxSingleTransAmount > (payload.initQuantity - payload.frozenQuantity) * payload.price) {
          payload.maxSingleTransAmount = parseFloat(payload.initQuantity - payload.frozenQuantity) * payload.price - 1000;
        }

        // 7. Gọi API
        console.log("Check payload " + JSON.stringify(payload));
        const result = await api.post('/api/my/ads/update', payload);

        if (result.code === 0) {
          ad.price = newPrice;
          setApRowStatus(advNo, `Đã cập nhật → ${formatNumber(newPrice)}`, 'ok');
          apLog(`[${truncateId(advNo)}] ${side} | Best: ${formatNumber(bestPrice)} | Mới: ${formatNumber(newPrice)}`, 'success');
        } else {
          setApRowStatus(advNo, `Lỗi: ${result.msg}`, 'err');
          apLog(`[${truncateId(advNo)}] Lỗi API: ${result.msg}`, 'error');
        }

        loadMyAds();

      } catch (err) {
        setApRowStatus(advNo, `Lỗi: ${err.message}`, 'err');
        apLog(`[${truncateId(advNo)}] Exception: ${err.message}`, 'error');
      }
    }
  }

  function startAutoPricer() {
    if (apTimer) return;
    const interval = Math.max(5, parseInt(document.getElementById('apScanInterval').value) || 30) * 1000;
    updateApStatusUI(true);
    apLog(`Auto-pricer bắt đầu — quét mỗi ${interval / 1000}s`, 'success');
    apRunCycle();
    apTimer = setInterval(apRunCycle, interval);
  }

  function stopAutoPricer() {
    if (apTimer) { clearInterval(apTimer); apTimer = null; }
    updateApStatusUI(false);
    apLog('Auto-pricer đã dừng', 'warn');
  }

  // ═══════════════════════════════════════════════════════
  // TEST CẬP NHẬT GIÁ QUẢNG CÁO
  // ═══════════════════════════════════════════════════════

  async function submitTestUpdateAd() {
    const advNo = document.getElementById('testAdvNo').value.trim();
    const price = document.getElementById('testPrice').value.trim();

    if (!advNo) { showToast('advNo là bắt buộc', 'error'); return; }
    if (!price)  { showToast('price là bắt buộc', 'error'); return; }

    const payload = { advNo, price: parseFloat(price) };

    const side = document.getElementById('testSide').value;
    if (side) payload.side = side;

    const fiatUnit = document.getElementById('testFiatUnit').value.trim();
    if (fiatUnit) payload.fiatUnit = fiatUnit;

    const coinId = document.getElementById('testCoinId').value.trim();
    if (coinId) payload.coinId = coinId;

    const payTimeLimit = document.getElementById('testPayTimeLimit').value.trim();
    if (payTimeLimit) payload.payTimeLimit = parseInt(payTimeLimit);

    const initQuantity = document.getElementById('testInitQuantity').value.trim();
    if (initQuantity) payload.initQuantity = parseFloat(initQuantity);

    const minAmount = document.getElementById('testMinAmount').value.trim();
    if (minAmount) payload.minSingleTransAmount = parseFloat(minAmount);

    const maxAmount = document.getElementById('testMaxAmount').value.trim();
    if (maxAmount) payload.maxSingleTransAmount = parseFloat(maxAmount);

    const payMethod = document.getElementById('testPayMethod').value.trim();
    if (payMethod) payload.payMethod = payMethod;

    const countryCode = document.getElementById('testCountryCode').value.trim();
    if (countryCode) payload.countryCode = countryCode;

    const kycLevel = document.getElementById('testKycLevel').value.trim();
    if (kycLevel) payload.kycLevel = kycLevel;

    setLoading(true, 'testUpdateBtn');
    const responseEl = document.getElementById('testUpdateResponse');
    const responseText = document.getElementById('testUpdateResponseText');
    responseEl.style.display = 'none';
    try {
      const result = await api.post('/api/my/ads/update', payload);

      responseEl.style.display = 'block';
      responseText.textContent = JSON.stringify(result, null, 2);
      if (result.code === 0) {
        showToast('Cập nhật thành công!', 'success');
        await loadMyAds();
      } else {
        showToast(`Lỗi: ${result.msg || 'Thất bại'}`, 'error');
      }
    } catch (err) {
      responseEl.style.display = 'block';
      responseText.textContent = err.message;
      showToast('Lỗi gửi request: ' + err.message, 'error');
    } finally {
      setLoading(false, 'testUpdateBtn');
    }
  }

  function clearTestUpdateForm() {
    ['testAdvNo', 'testPrice', 'testPayTimeLimit', 'testInitQuantity', 'testMinAmount', 'testMaxAmount'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('testFiatUnit').value = 'VND';
    document.getElementById('testCoinId').value = '128f589271cb4951b03e71e6323eb7be';
    document.getElementById('testPayMethod').value = '1';
    document.getElementById('testCountryCode').value = 'VN';
    document.getElementById('testKycLevel').value = 'PRIMARY';
    document.getElementById('testSide').value = 'BUY';
    document.getElementById('testUpdateResponse').style.display = 'none';
  }

  // ─── Khởi tạo ────────────────────────────────────────

  async function init() {
    // ★ MỚI: Load whitelist ngay khi khởi động (không cần kết nối)
    await loadWhitelist();
    await loadSettings();        // ★ tải cấu hình đã lưu
    prefillCredentials();        // ★ điền sẵn thông tin đăng nhập

    // ★ MỚI: Bắt đầu polling giá Binance
    // startBinancePricePolling();

    startPriceBoardPolling();

    const status = await api.get('/api/status');
    if (status.data?.connected) {
      state.connected = true;
      updateConnectionUI(true, '');
      await loadMyAds();
      restoreMexcPricerConfig();   // ★
      renderAutoPricerTable();     // ★
    }
    if (status.data?.secondaryConnected) {
      state.secondaryConnected = true;
      updateSecondaryConnectionUI(true, '');
      await loadMarketAds('BUY');
      await loadMarketAds('SELL');
    }
    // ★ MỚI: Check Bitget connection
    if (status.data?.bitgetConnected) {
      state.bgConnected = true;
      updateBgConnectionUI(true);
      await loadBitgetAds();
      restoreBitgetPricerConfig(); // ★
    }

    const config = await api.get('/api/config');
    if (config.data?.apiHosts) {
      const hosts = config.data.apiHosts.map(h => `<option value="${h.value}">${h.label}</option>`).join('');
      document.getElementById('apiHost').innerHTML = hosts;
      document.getElementById('apiHost2').innerHTML = hosts;
    }

    renderBgApRows();
  }

  // ─── Public API ──────────────────────────────────────
  return {
    init,
    connect,
    disconnect,
    connectSecondary,
    disconnectSecondary,
    switchTab,
    refreshAds,
    changePage,
    loadMarketAds,
    updateMarketFilters,
    loadMyAds,
    filterMyAds,
    changeMyAdsPage,
    viewAd,
    togglePasswordVisibility,
    submitTestUpdateAd,
    clearTestUpdateForm,
    renderAutoPricerTable,
    startAutoPricer,
    stopAutoPricer,
    apToggle,
    apSetCfg,
    clearAutoPricerLog,
    // ★ MỚI: Whitelist functions
    addWhitelistMerchant,
    removeWhitelistMerchant,
    // ★ MỚI: Binance price
    loadBinancePrice,
    // ★ MỚI: Bitget P2P
    connectBitget,
    disconnectBitget,
    loadBitgetAds,
    startBitgetPricer,
    stopBitgetPricer,
    lookupBitgetAd,
    loadBgMarket,
    switchBgMarketTab,
    changeBgMarketPage,
    submitBitgetUpdateAd,
    clearBitgetUpdateForm,
    bgApAddRow,
    bgApRemoveRow,
    bgApSetRow,
    saveMexcCreds,
    saveBitgetCreds,
    saveMexcPricer,
    saveBitgetPricer,
    refreshPriceBoard,
    connectBybit,
    disconnectBybit,
    loadBybitAds,
    saveBybitCreds,
    testBybitMarket,
    loadBybitAdIntoForm,
    loadBybitPayments,
    submitBybitUpdate,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
