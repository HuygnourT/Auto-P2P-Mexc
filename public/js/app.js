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
    byApRows: [],   // [{ id, side, advId, tokenId, currencyId, searchAmount, offset, priceLimit, refill, enabled, lastStatus }]

    // ★ BingX P2P
    bxConnected: false,
    bxAds: [],            // ads của tôi (Listed + Delisted) từ 3.10 myAdvert
    bxAdvNos: new Set(),
    bxAdsFilter: 'ALL',
    bxConfigs: {},        // cấu hình auto-pricer theo advertNo

    // ★ Engine trên server (dùng chung với Telegram)
    engine: {},           // ex → trạng thái engine
    best: {},             // ex → giá tốt nhất (dùng chung bảng giá / thanh trạng thái)
    mk: {},               // ex → { side, loadedAt } của thẻ Market
    telegram: null,
    audit: [],
  };

  // Timer auto-refresh (handle của setInterval)
  let autoRefreshTimer = null;

  // ★ MỚI: Binance price polling
  let bnPriceTimer = null;
  let pbTimer = null;
  let bnCountdown = 60;


  const sleep = (ms) => new Promise(res => setTimeout(res, ms));


  // Mỗi tab trình duyệt 1 id → server biết thay đổi nào do chính tab này gửi (không vẽ lại thừa)
  const CLIENT_ID = Math.random().toString(36).slice(2, 10);

  // ─── API Client: Gửi request đến backend ─────────────
  const api = {
    async post(url, data) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
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

  if (s.bingx) {
    set('bxApiKey', s.bingx.apiKey); set('bxSecretKey', s.bingx.secretKey);
    if (s.bingx.postMode) set('bxPostMode', s.bingx.postMode);
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

async function saveMexcPricer() { await pushGlobalSettings('mexc', { scanInterval: document.getElementById('apScanInterval').value }); autosavedToast(); }

async function saveBitgetPricer() {
  await pushGlobalSettings('bitget', {
    scanInterval: document.getElementById('bgScanInterval').value,
    offsetBuy: document.getElementById('bgOffsetBuy').value,
    offsetSell: document.getElementById('bgOffsetSell').value,
  });
  autosavedToast();
}

// Cấu hình auto-pricer giờ nằm trên server (dùng chung với Telegram) → nạp lại từ engine
function restoreMexcPricerConfig() { refreshEngineState('mexc'); }
function restoreBitgetPricerConfig() { refreshEngineState('bitget'); }
function restoreBybitPricerConfig() { refreshEngineState('bybit'); }

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

  // Bảng giá dùng chung dữ liệu market + quy tắc xếp hạng với engine (server có cache, không gọi sàn trùng)
  function setPbCell(id, value, err) {
    const el = document.getElementById(id);
    if (!el) return;
    el.title = err || '';
    if (value === null || value === undefined) el.textContent = err && /kết nối/i.test(err) ? 'Chưa kết nối' : '—';
    else el.textContent = formatNumber(value);
  }

  async function refreshPriceBoard(fresh = false) {
    const amount = parseFloat(document.getElementById('pbAmount')?.value) || 0;
    try {
      const r = await api.get(`/api/market/best?ex=all&amount=${amount}${fresh === true ? '&fresh=1' : ''}`);
      if (r.code !== 0) return;
      const ids = { mexc: 'Mexc', bitget: 'Bitget', bybit: 'Bybit', bingx: 'Bingx' };
      for (const [ex, b] of Object.entries(r.data)) {
        state.best[ex] = b;
        setPbCell(`pb${ids[ex]}Buy`, b.buy, b.error);
        setPbCell(`pb${ids[ex]}Sell`, b.sell, b.error);
        const at = document.getElementById(`pb${ids[ex]}At`);
        if (at) at.textContent = b.at && !(b.error && b.buy === null && b.sell === null) ? `${timeVN(b.at)}${b.cached ? ' ·cache' : ''}` : '—';
        renderStrip(ex);
      }
    } catch (err) { console.error('[PriceBoard]', err); }
  }

  function startPriceBoardPolling() {
    refreshPriceBoard();
    pbTimer = setInterval(refreshPriceBoard, 15000);  // tự cập nhật mỗi 15s (server cache 30s)
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
      tbody.innerHTML = '<tr><td colspan="14" class="ap-empty">Chưa có dòng nào. Bấm "➕ Thêm dòng" để cấu hình.</td></tr>';
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
        <td><input type="number" class="ap-num-input" value="${(r.side === 'buy' ? r.priceFloor : r.priceCeiling) ?? ''}" placeholder="${r.side === 'buy' ? 'Sàn' : 'Trần'}" onchange="App.bgApSetRow(${r.id},'${r.side === 'buy' ? 'priceFloor' : 'priceCeiling'}',this.value)"></td>
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

  async function bgApAddRow() {
    const r = await api.post('/api/engine/bitget/rows', { side: 'buy' });
    if (r.code === 0) { state.bgApRows.push({ ...r.data, lastStatus: '' }); renderBgApRows(); }
    else showToast('Không thêm được dòng: ' + (r.msg || ''), 'error');
  }

  async function bgApRemoveRow(id) {
    const r = await api.post(`/api/engine/bitget/rows/${id}/delete`, {});
    if (r.code === 0) { state.bgApRows = state.bgApRows.filter(x => x.id !== id); renderBgApRows(); }
  }

  function bgApSetRow(id, field, value) {
    const row = state.bgApRows.find(r => r.id === id);
    if (!row) return;
    row[field] = value;
    pushAdCfg('bitget', id, { [field]: value });
    // Đổi side → cập nhật placeholder Trần/Sàn
    if (field === 'side') renderBgApRows();
  }

  function startBitgetPricer() { engineStart('bitget'); }
  function stopBitgetPricer() { engineStop('bitget'); }

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
      restoreBybitPricerConfig();   // ★ khôi phục cấu hình đã lưu
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

  async function byApAddRow() {
    const r = await api.post('/api/engine/bybit/rows', { side: 'buy' });
    if (r.code === 0) { state.byApRows.push({ ...r.data, lastStatus: '' }); renderByApRows(); }
    else showToast('Không thêm được dòng: ' + (r.msg || ''), 'error');
  }

  const BY_BUY_REFILL_QTY = 20000;   // SL tự refill cho ad BUY (chế độ 'refill')

  async function byApRemoveRow(id) {
    const r = await api.post(`/api/engine/bybit/rows/${id}/delete`, {});
    if (r.code === 0) { state.byApRows = state.byApRows.filter(x => x.id !== id); renderByApRows(); }
  }

  function byApSetRow(id, field, value) {
    const row = state.byApRows.find(r => r.id === id);
    if (!row) return;
    row[field] = value;
    pushAdCfg('bybit', id, { [field]: value });
    if (field === 'side' || field === 'qtyMode') renderByApRows();
  }

  function renderByApRows() {
    const tbody = document.getElementById('byApTableBody');
    if (!tbody) return;
    if (!state.byApRows.length) {
      tbody.innerHTML = '<tr><td colspan="15" class="ap-empty">Chưa có dòng nào.</td></tr>';
      return;
    }
    tbody.innerHTML = state.byApRows.map(r => {
      const isSell = r.side === 'sell';
      const keepQty = isSell || r.qtyMode === 'keep';   // SELL luôn giữ SL hiện tại
      const qtyCell = isSell
        ? `<select class="ap-num-input" style="width:150px" disabled title="SELL luôn giữ số lượng hiện tại (+ refill tay)"><option>Giữ SL hiện tại</option></select>`
        : `<select class="ap-num-input" style="width:150px" onchange="App.byApSetRow(${r.id},'qtyMode',this.value)">
            <option value="refill" ${r.qtyMode !== 'keep' ? 'selected' : ''}>Refill ${formatNumber(BY_BUY_REFILL_QTY)}</option>
            <option value="keep" ${r.qtyMode === 'keep' ? 'selected' : ''}>Giữ SL hiện tại</option></select>`;
      return `<tr id="by-ap-row-${r.id}">
        <td><select class="ap-num-input" style="width:80px" onchange="App.byApSetRow(${r.id},'side',this.value)">
          <option value="buy" ${!isSell ? 'selected' : ''}>MUA</option>
          <option value="sell" ${isSell ? 'selected' : ''}>BÁN</option></select></td>
        <td><input type="text" class="ap-num-input" style="width:160px" value="${escapeHtml(r.advId)}" placeholder="Ad ID" onchange="App.byApSetRow(${r.id},'advId',this.value.trim())"></td>
        <td><input type="text" class="ap-num-input" style="width:60px" value="${escapeHtml(r.tokenId)}" onchange="App.byApSetRow(${r.id},'tokenId',this.value.trim())"></td>
        <td><input type="text" class="ap-num-input" style="width:60px" value="${escapeHtml(r.currencyId)}" onchange="App.byApSetRow(${r.id},'currencyId',this.value.trim())"></td>
        <td><label class="toggle"><input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="App.byApSetRow(${r.id},'enabled',this.checked)"><span class="toggle-slider"></span></label></td>
        <td><input type="number" class="ap-num-input" style="width:110px" value="${r.searchAmount}" placeholder="—" onchange="App.byApSetRow(${r.id},'searchAmount',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:80px" value="${r.offset}" placeholder="0" onchange="App.byApSetRow(${r.id},'offset',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${r.priceLimit}" placeholder="${isSell ? 'Sàn' : 'Trần'}" onchange="App.byApSetRow(${r.id},'priceLimit',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${(isSell ? r.priceCeiling : r.priceFloor) ?? ''}" placeholder="${isSell ? 'Trần' : 'Sàn'}" onchange="App.byApSetRow(${r.id},'${isSell ? 'priceCeiling' : 'priceFloor'}',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${r.minAmount}" placeholder="—" onchange="App.byApSetRow(${r.id},'minAmount',this.value)"></td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${r.maxAmount}" placeholder="—" onchange="App.byApSetRow(${r.id},'maxAmount',this.value)"></td>
        <td>${qtyCell}</td>
        <td><input type="number" class="ap-num-input" style="width:100px" value="${r.refill}" placeholder="${keepQty ? '0' : 'N/A'}" ${keepQty ? '' : 'disabled'} onchange="App.byApSetRow(${r.id},'refill',this.value)"></td>
        <td><span class="ap-row-status" id="by-ap-status-${r.id}">${escapeHtml(r.lastStatus) || '—'}</span></td>
        <td><button class="btn-remove" style="padding:4px 10px;font-size:11px;border-radius:4px;border:1px solid rgba(239,68,68,0.3);background:rgba(255,255,255,0.04);color:var(--red);cursor:pointer" onclick="App.byApRemoveRow(${r.id})">Xóa</button></td>
      </tr>`;
    }).join('');
  }

  function startBybitPricer() { engineStart('bybit'); }
  function stopBybitPricer() { engineStop('bybit'); }

  async function saveBybitPricer() {
    await pushGlobalSettings('bybit', {
      scanInterval: document.getElementById('byScanInterval').value,
      onlineOnly: document.getElementById('byOnlineOnly')?.checked ?? true,
    });
    autosavedToast();
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
        await loadMexcAdText(false); // ★ hiện Automated Reply / Advertiser Terms (Tiếng Việt)
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
    document.querySelectorAll('#myAdsCard .filter-chip').forEach(chip => {
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
  // MEXC — Automated Reply & Advertiser Terms
  //   Nhập Tiếng Việt → server lưu → saveOrUpdateAd convert UTF-8 khi gửi
  // ═══════════════════════════════════════════════════════

  let mexcAdTextDirty = false;

  // Giống server (utils/mexcText.js): encode UTF-8 chặt, encode cả ! ' ( ) *
  function mexcLooksEncoded(str) {
    return /^[A-Za-z0-9\-_.~%]*$/.test(str) && /%[0-9A-Fa-f]{2}/.test(str);
  }
  function mexcEncodeText(str) {
    const s = String(str || '').replace(/\r\n/g, '\n');
    if (!s || mexcLooksEncoded(s)) return s;
    return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  function mexcDecodeText(str) {
    const s = String(str || '');
    if (!mexcLooksEncoded(s)) return s;
    try { return decodeURIComponent(s); } catch { return s; }
  }

  function setMexcAdTextStatus(msg) {
    const el = document.getElementById('mexcAdTextStatus');
    if (el) el.textContent = msg;
  }

  // Cập nhật bản xem trước UTF-8 + đếm ký tự
  function mexcAdTextPreview(fromInput = true) {
    if (fromInput) mexcAdTextDirty = true;
    [['mexcAutoReplyMsg'], ['mexcTradeTerms']].forEach(([id]) => {
      const ta = document.getElementById(id);
      if (!ta) return;
      // Người dùng dán chuỗi đã encode → tự đổi về Tiếng Việt
      if (mexcLooksEncoded(ta.value.trim())) ta.value = mexcDecodeText(ta.value.trim());
      const enc = mexcEncodeText(ta.value);
      const pre = document.getElementById(id + 'Encoded');
      if (pre) pre.textContent = enc || '(trống — không gửi field này)';
      const cnt = document.getElementById(id + 'Count');
      if (cnt) cnt.textContent = `${ta.value.length} ký tự · ${enc.length} encoded`;
    });
    if (fromInput) setMexcAdTextStatus('Có thay đổi chưa lưu');
  }

  function fillMexcAdText(data) {
    const ar = document.getElementById('mexcAutoReplyMsg');
    const tt = document.getElementById('mexcTradeTerms');
    if (!ar || !tt) return;
    ar.value = mexcDecodeText(data.autoReplyMsg || '');
    tt.value = mexcDecodeText(data.tradeTerms || '');
    let note = data.isDefault ? 'Đang dùng nội dung mặc định' : 'Đã tải nội dung đã lưu';

    // Chưa lưu Advertiser Terms → hiện terms hiện tại của ads MEXC (nếu có) để chỉnh
    if (data.isDefault && !tt.value) {
      const adWithTerms = (state.myAds || []).find(a => a.tradeTerms);
      if (adWithTerms) {
        tt.value = mexcDecodeText(adWithTerms.tradeTerms);
        note += ' · Terms lấy từ ad hiện tại (bấm Lưu để áp dụng)';
      }
    }
    mexcAdTextDirty = false;
    mexcAdTextPreview(false);
    setMexcAdTextStatus(note);
  }

  async function loadMexcAdText(force = true) {
    if (!force && mexcAdTextDirty) return;   // không ghi đè nội dung đang soạn
    try {
      const r = await api.get('/api/mexc/ad-text');
      if (r.code === 0 && r.data) fillMexcAdText(r.data);
      else showToast('Lỗi tải nội dung quảng cáo: ' + (r.msg || ''), 'error');
    } catch (err) {
      showToast('Lỗi tải nội dung quảng cáo: ' + err.message, 'error');
    }
  }

  async function saveMexcAdText() {
    const autoReplyMsg = document.getElementById('mexcAutoReplyMsg').value;
    const tradeTerms = document.getElementById('mexcTradeTerms').value;
    try {
      const r = await api.post('/api/mexc/ad-text', { autoReplyMsg, tradeTerms });
      if (r.code === 0) {
        fillMexcAdText(r.data);
        setMexcAdTextStatus('Đã lưu · áp dụng từ lần cập nhật ad tiếp theo');
        showToast('Đã lưu Automated Reply / Advertiser Terms', 'success');
      } else {
        showToast('Lỗi lưu: ' + (r.msg || ''), 'error');
      }
    } catch (err) {
      showToast('Lỗi lưu: ' + err.message, 'error');
    }
  }

  async function resetMexcAdText() {
    if (!window.confirm('Khôi phục nội dung mặc định? Nội dung đã lưu sẽ bị xóa.')) return;
    try {
      const r = await api.post('/api/mexc/ad-text/reset', {});
      if (r.code === 0) { fillMexcAdText(r.data); showToast('Đã khôi phục mặc định', 'info'); }
      else showToast('Lỗi: ' + (r.msg || ''), 'error');
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  }

  // ═══════════════════════════════════════════════════════
  // AUTO-PRICER — Tự động chỉnh giá
  // ═══════════════════════════════════════════════════════


  function renderAutoPricerTable() {
    const tbody = document.getElementById('apTableBody');
    if (!tbody) return;

    const ads = state.myAds;
    if (!ads || ads.length === 0) {
      tbody.innerHTML = '<tr><td colspan="16" class="ap-empty">Kết nối API chính và tải quảng cáo để cấu hình</td></tr>';
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
          payMethod: 1799581,
          lastStatus: '',
        };
      }
      const c = state.apConfigs[advNo];
      if (c.payMethod == null) c.payMethod = 1799581;   // backfill cho cấu hình cũ đã lưu

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
          <td><input type="number" class="ap-num-input" value="${(isBuy ? c.priceFloor : c.priceCeiling) ?? ''}" placeholder="${isBuy ? 'Sàn' : 'Trần'}" onchange="App.apSetCfg('${advNo}','${isBuy ? 'priceFloor' : 'priceCeiling'}',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.refillThreshold}" placeholder="—" onchange="App.apSetCfg('${advNo}','refillThreshold',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.refillQuantity}" placeholder="—" onchange="App.apSetCfg('${advNo}','refillQuantity',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.minTrans}" placeholder="—" onchange="App.apSetCfg('${advNo}','minTrans',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.maxTrans}" placeholder="—" onchange="App.apSetCfg('${advNo}','maxTrans',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.userAllTradeCountMin}" placeholder="—" onchange="App.apSetCfg('${advNo}','userAllTradeCountMin',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.userAllTradeCountMax}" placeholder="—" onchange="App.apSetCfg('${advNo}','userAllTradeCountMax',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.filterMaxSingleTransAmount}" placeholder="—" onchange="App.apSetCfg('${advNo}','filterMaxSingleTransAmount',this.value)"></td>
          <td><input type="number" class="ap-num-input" value="${c.payMethod}" placeholder="1799581" ${isBuy ? 'disabled title="Chỉ áp dụng cho ads SELL"' : ''} onchange="App.apSetCfg('${advNo}','payMethod',this.value)"></td>
          <td><span class="ap-row-status" id="ap-status-${advNo}">${c.lastStatus || '—'}</span></td>
        </tr>`;
    }).join('');
  }

  function apToggle(advNo, enabled) {
    if (!state.apConfigs[advNo]) return;
    state.apConfigs[advNo].enabled = enabled;
    pushAdCfg('mexc', advNo, { enabled });
  }

  function apSetCfg(advNo, field, value) {
    if (!state.apConfigs[advNo]) return;
    const num = parseFloat(value);
    const v = value === '' ? '' : (isNaN(num) ? value : num);
    state.apConfigs[advNo][field] = v;
    pushAdCfg('mexc', advNo, { [field]: v });
  }

  function apLog(msg, type = '') {
    exActivity('mexc', msg, type);
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

  function updateApStatusUI(running) {   // (giữ để tương thích — trạng thái thật do engine server gửi về)
    setTimeout(renderExSummary, 0);
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

  function startAutoPricer() { engineStart('mexc'); }
  function stopAutoPricer() { engineStop('mexc'); }

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

  // ═══════════════════════════════════════════════════════
  // TAB CÁC SÀN + BẢNG TRẠNG THÁI CÁC SÀN
  // ═══════════════════════════════════════════════════════

  const EXCHANGES = ['mexc', 'bitget', 'bybit', 'bingx'];
  const EX_LABEL = { mexc: 'MEXC', bitget: 'Bitget', bybit: 'Bybit', bingx: 'BingX' };
  const exStatus = {};
  EXCHANGES.forEach(ex => { exStatus[ex] = { lastCycle: null, updates: 0, lastMsg: '', lastType: '', lastAt: null }; });

  function switchExchange(ex) {
    if (!EXCHANGES.includes(ex) && ex !== 'telegram') ex = 'mexc';
    if (ex === 'telegram') { loadTelegram(); loadAudit(); }
    else if (!state.mk[ex]?.loadedAt || Date.now() - state.mk[ex].loadedAt > 60000) setTimeout(() => mkLoad(ex), 0);
    document.querySelectorAll('.ex-tab').forEach(b => b.classList.toggle('active', b.dataset.ex === ex));
    document.querySelectorAll('.ex-panel').forEach(p => p.classList.toggle('active', p.dataset.ex === ex));
    try { localStorage.setItem('p2p.activeExchange', ex); } catch (_) {}
  }

  function restoreActiveExchange() {
    let ex = 'mexc';
    try { ex = localStorage.getItem('p2p.activeExchange') || 'mexc'; } catch (_) {}
    switchExchange(ex);
  }

  // Ghi nhận hoạt động gần nhất (gọi từ các hàm log của từng sàn)
  function exActivity(ex, msg, type) {
    const s = exStatus[ex]; if (!s) return;
    s.lastMsg = msg; s.lastType = type || ''; s.lastAt = Date.now();
  }
  function exCycle(ex) { if (exStatus[ex]) exStatus[ex].lastCycle = Date.now(); }
  function exCountUpdate(ex) { if (exStatus[ex]) exStatus[ex].updates++; }

  function exAgo(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s trước`;
    if (s < 3600) return `${Math.floor(s / 60)}p trước`;
    return new Date(ts).toLocaleTimeString('vi-VN');
  }

  function exInfo(ex) {
    const val = id => document.getElementById(id)?.value;
    switch (ex) {
      case 'mexc': {
        const enabled = (state.myAds || []).filter(a => state.apConfigs[a.advNo || a.davNo || '']?.enabled).length;
        return {
          connected: state.connected,
          connNote: state.connected ? (state.secondaryConnected ? 'Chính + Phụ' : 'Chính (chưa có API phụ)') : '',
          running: !!state.engine.mexc?.running, enabled, total: (state.myAds || []).length, interval: val('apScanInterval'),
        };
      }
      case 'bitget':
        return {
          connected: state.bgConnected, running: !!state.engine.bitget?.running,
          enabled: (state.bgApRows || []).filter(r => r.enabled && r.advId).length,
          total: (state.bgApRows || []).length, interval: val('bgScanInterval'),
        };
      case 'bybit':
        return {
          connected: state.byConnected, running: !!state.engine.bybit?.running,
          enabled: (state.byApRows || []).filter(r => r.enabled && r.advId).length,
          total: (state.byApRows || []).length, interval: val('byScanInterval'),
        };
      case 'bingx':
        return {
          connected: state.bxConnected, running: !!state.engine.bingx?.running,
          enabled: (state.bxAds || []).filter(a => state.bxConfigs[a.advertNo]?.enabled).length,
          total: (state.bxAds || []).length, interval: val('bxScanInterval'),
        };
    }
    return {};
  }

  function renderExSummary() {
    const body = document.getElementById('exSummaryBody');
    const rows = EXCHANGES.map(ex => {
      const i = exInfo(ex), s = exStatus[ex];
      // chấm trạng thái trên tab
      const dot = document.getElementById(`exDot-${ex}`);
      if (dot) dot.className = 'ex-dot' + (i.connected ? ' on' : '');
      const run = document.getElementById(`exRun-${ex}`);
      if (run) { run.textContent = i.running ? '▶' : ''; run.title = i.running ? 'Auto-pricer đang chạy' : ''; }

      const conn = i.connected
        ? `<span class="ex-pill ok">● Đã kết nối</span>${i.connNote ? `<div class="ex-sub">${escapeHtml(i.connNote)}</div>` : ''}`
        : '<span class="ex-pill off">○ Chưa kết nối</span>';
      const es = state.engine[ex] || {};
      const runCell = es.state === 'error' ? `<span class="ex-pill err" title="${escapeHtml(es.error || '')}">⚠️ Lỗi</span>`
        : i.running ? '<span class="ex-pill run">▶ Đang chạy</span>' : '<span class="ex-pill off">⏸ Tạm dừng</span>';
      const msgCls = s.lastType === 'error' ? 'err' : s.lastType === 'warn' ? 'warn' : s.lastType === 'success' ? 'ok' : '';
      const msg = s.lastMsg ? `<span class="ex-msg ${msgCls}" title="${escapeHtml(s.lastMsg)}">${escapeHtml(s.lastMsg)}</span><div class="ex-sub">${exAgo(s.lastAt)}</div>` : '<span class="ex-sub">—</span>';
      return `<tr class="ex-row" onclick="App.switchExchange('${ex}')">
        <td><strong>${EX_LABEL[ex]}</strong></td>
        <td>${conn}</td>
        <td>${runCell}</td>
        <td class="mono-cell">${i.enabled} / ${i.total}</td>
        <td class="mono-cell">${i.interval ? i.interval + 's' : '—'}</td>
        <td class="mono-cell">${exAgo(es.lastCycleAt || s.lastCycle)}</td>
        <td class="mono-cell">${es.updates ?? s.updates}</td>
        <td class="ex-msg-cell">${msg}</td>
      </tr>`;
    });
    if (body) body.innerHTML = rows.join('');
  }

  // ═══════════════════════════════════════════════════════
  // BINGX P2P — Kết nối, Ads của tôi, Auto-pricer
  //   3.10 myAdvert (ads của tôi) · 3.1 advert/list (market) · 3.8 advert/modify (sửa giá)
  // ═══════════════════════════════════════════════════════

  const BX_PAY_TIME = { 1: '15 phút', 2: '30 phút', 3: '45 phút', 4: '1 giờ' };
  const bxIsBuy = ad => Number(ad.tradeType) === 1;          // tradeType (góc nhìn merchant): 1 mua, 2 bán
  const bxIsOnline = ad => Number(ad.status) === 0;          // status: 0 Listed (online), 1 Delisted (offline)
  const bxCurrentPrice = ad => parseFloat(ad.fixedPrice);

  function bxLog(msg, type = '') {
    exActivity('bingx', msg, type);
    const log = document.getElementById('bxLog');
    if (!log) return;
    const empty = log.querySelector('.ap-log-empty');
    if (empty) empty.remove();
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const entry = document.createElement('div');
    entry.className = 'ap-log-entry';
    entry.innerHTML = `<span class="ap-log-time">${time}</span><span class="ap-log-msg ${type}">${escapeHtml(msg)}</span>`;
    log.insertBefore(entry, log.firstChild);
    while (log.children.length > 200) log.removeChild(log.lastChild);
  }

  function clearBingxLog() {
    const log = document.getElementById('bxLog');
    if (log) log.innerHTML = '<div class="ap-log-empty">Chưa có hoạt động nào</div>';
  }

  function updateBxConnectionUI(connected) {
    document.getElementById('bxStatusDot').className = 'status-dot' + (connected ? ' connected' : '');
    document.getElementById('bxStatusText').textContent = connected ? 'Đã kết nối' : 'Chưa kết nối';
    document.getElementById('bxConnectBtn').style.display = connected ? 'none' : 'inline-flex';
    document.getElementById('bxDisconnectBtn').style.display = connected ? 'inline-flex' : 'none';
    document.getElementById('bxCredentials').classList.toggle('locked', connected);
  }

  async function connectBingx() {
    const apiKey = document.getElementById('bxApiKey').value.trim();
    const secretKey = document.getElementById('bxSecretKey').value.trim();
    const postMode = document.getElementById('bxPostMode').value;
    if (!apiKey || !secretKey) { showToast('Vui lòng nhập API Key và Secret Key BingX', 'error'); return; }
    setLoading(true, 'bxConnectBtn');
    try {
      const r = await api.post('/api/bingx/connect', { apiKey, secretKey, postMode });
      if (r.code === 0) {
        state.bxConnected = true;
        updateBxConnectionUI(true);
        showToast('Đã kết nối BingX', 'success');
        restoreBingxPricerConfig();
        setBingxAds(r.data?.result || []);
        appendLog('bingx', `Kết nối BingX — ${state.bxAds.length} quảng cáo`, 'success');
      } else {
        showToast(`BingX: ${r.msg || 'Kết nối thất bại'} (code ${r.code})`, 'error');
      }
    } catch (err) {
      showToast('Lỗi kết nối BingX: ' + err.message, 'error');
    } finally {
      setLoading(false, 'bxConnectBtn');
    }
  }

  // Kiểm tra kết nối từng bước: mạng → market → API key/chữ ký → ads của tôi
  async function diagnoseBingx() {
    const apiKey = document.getElementById('bxApiKey').value.trim();
    const secretKey = document.getElementById('bxSecretKey').value.trim();
    if (!apiKey || !secretKey) { showToast('Nhập API Key và Secret Key BingX trước', 'error'); return; }
    const box = document.getElementById('bxDiagResult');
    box.style.display = 'flex';
    box.innerHTML = '<div class="bx-diag-row">Đang kiểm tra...</div>';
    setLoading(true, 'bxDiagBtn');
    try {
      const r = await api.post('/api/bingx/diagnose', { apiKey, secretKey });
      if (r.code !== 0) { box.innerHTML = `<div class="bx-diag-row err">${escapeHtml(r.msg || 'Lỗi')}</div>`; return; }
      box.innerHTML = r.data.map(s => `<div class="bx-diag-row ${s.ok ? 'ok' : 'err'}">
          <div><strong>${s.ok ? '✅' : '❌'} ${escapeHtml(s.step)}</strong></div>
          <div class="bx-diag-detail">${escapeHtml(s.detail || '')}</div>
          ${s.hint ? `<div class="bx-diag-hint">→ ${escapeHtml(s.hint)}</div>` : ''}
        </div>`).join('');
    } catch (err) {
      box.innerHTML = `<div class="bx-diag-row err">${escapeHtml(err.message)}</div>`;
    } finally {
      setLoading(false, 'bxDiagBtn');
    }
  }

  async function disconnectBingx() {
    await api.post('/api/bingx/disconnect');
    state.bxConnected = false;
    state.bxAds = [];
    updateBxConnectionUI(false);
    renderBingxAds();
    renderBingxPricerTable();
    showToast('Đã ngắt BingX', 'info');
  }

  async function saveBingxCreds() {
    const data = {
      apiKey: document.getElementById('bxApiKey').value.trim(),
      secretKey: document.getElementById('bxSecretKey').value.trim(),
      postMode: document.getElementById('bxPostMode').value,
    };
    const r = await api.post('/api/settings/bingx', data);
    if (r.code === 0) { state.savedSettings = r.data; showToast('Đã lưu đăng nhập BingX', 'success'); }
    else showToast('Lỗi lưu: ' + (r.msg || ''), 'error');
  }

  function setBingxAds(list) {
    state.bxAds = list || [];
    state.bxAdvNos = new Set(state.bxAds.map(a => String(a.advertNo)));
    renderBingxAds();
    renderBingxPricerTable();
  }

  async function loadBingxAds(silent = false) {
    if (!state.bxConnected) return false;
    try {
      const r = await api.get('/api/bingx/my-ads');
      if (r.code === 0) { setBingxAds(r.data?.result || []); return true; }
      if (!silent) showToast(`BingX: ${r.msg || 'Lỗi lấy ads'}`, 'error');
      bxLog(`Lỗi lấy ads của tôi: ${r.msg || r.code}`, 'error');
    } catch (err) {
      if (!silent) showToast('Lỗi: ' + err.message, 'error');
      bxLog(`Lỗi lấy ads của tôi: ${err.message}`, 'error');
    }
    return false;
  }

  function filterBingxAds(filter) {
    state.bxAdsFilter = filter;
    document.querySelectorAll('.bx-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === filter));
    renderBingxAds();
  }

  function renderBingxAds() {
    const tbody = document.getElementById('bxAdsBody');
    if (!tbody) return;
    const all = state.bxAds || [];
    const on = all.filter(bxIsOnline).length;
    const cnt = document.getElementById('bxAdsCount');
    if (cnt) cnt.textContent = all.length ? `${all.length} ads · ${on} online · ${all.length - on} offline` : '';

    const f = state.bxAdsFilter || 'ALL';
    const ads = all.filter(a => f === 'ALL' || (f === 'ON' ? bxIsOnline(a) : !bxIsOnline(a)));
    if (!ads.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="9"><div class="empty-state"><p>${state.bxConnected ? 'Không có quảng cáo' : 'Kết nối BingX để xem quảng cáo'}</p></div></td></tr>`;
      return;
    }
    tbody.innerHTML = ads.map(ad => {
      const buy = bxIsBuy(ad), online = bxIsOnline(ad);
      const price = Number(ad.priceType) === 2
        ? `<span title="Giá thả nổi">${escapeHtml(String(ad.floatRatio))}%</span>`
        : formatNumber(bxCurrentPrice(ad));
      const pays = (ad.paymentMethods || []).map(p => escapeHtml(p.name || String(p.id))).join(', ') || '—';
      return `<tr>
        <td class="mono-cell" title="${escapeHtml(String(ad.advertNo))}">${truncateId(String(ad.advertNo))}</td>
        <td><span class="side-badge ${buy ? 'side-buy' : 'side-sell'}">${buy ? 'MUA' : 'BÁN'}</span></td>
        <td>${online ? '<span class="ex-pill ok">🟢 Online</span>' : '<span class="ex-pill off">🔴 Offline</span>'}</td>
        <td>${escapeHtml(ad.asset || '')}/${escapeHtml(ad.fiatUnit || '')}</td>
        <td class="mono-cell price-value ${buy ? 'price-buy' : 'price-sell'}">${price}</td>
        <td class="mono-cell">${formatNumber(parseFloat(ad.totalNumber))}</td>
        <td class="mono-cell">${formatNumber(parseFloat(ad.minAmount))} – ${formatNumber(parseFloat(ad.maxAmount))}</td>
        <td>${pays}</td>
        <td>${BX_PAY_TIME[ad.paymentTimeLimit] || escapeHtml(String(ad.paymentTimeLimit ?? '—'))}</td>
      </tr>`;
    }).join('');
  }

  function bxDefaultCfg() {
    return { enabled: false, searchAmount: '', offset: 0, priceLimit: '', minTrades30d: '', minAmount: '', maxAmount: '', priceFloor: '', priceCeiling: '', lastStatus: '' };
  }

  function renderBingxPricerTable() {
    const tbody = document.getElementById('bxApTableBody');
    if (!tbody) return;
    const ads = state.bxAds || [];
    if (!ads.length) {
      tbody.innerHTML = `<tr><td colspan="11" class="ap-empty">${state.bxConnected ? 'Không có quảng cáo' : 'Kết nối BingX để cấu hình'}</td></tr>`;
      return;
    }
    tbody.innerHTML = ads.map(ad => {
      const no = String(ad.advertNo);
      if (!state.bxConfigs[no]) state.bxConfigs[no] = bxDefaultCfg();
      const c = state.bxConfigs[no];
      const buy = bxIsBuy(ad), online = bxIsOnline(ad);
      const inp = (field, w, ph) => `<input type="number" class="ap-num-input" style="width:${w}px" value="${escapeHtml(String(c[field] ?? ''))}" placeholder="${ph}" onchange="App.bxSetCfg('${no}','${field}',this.value)">`;
      return `<tr>
        <td><div style="display:flex;flex-direction:column;gap:2px">
          <span class="mono-cell" style="font-size:11px" title="${no}">${truncateId(no)}</span>
          <span style="display:flex;gap:4px"><span class="side-badge ${buy ? 'side-buy' : 'side-sell'}" style="font-size:10px">${buy ? 'MUA' : 'BÁN'}</span>
          <span class="ex-sub">${online ? 'online' : 'offline'}</span></span></div></td>
        <td><label class="toggle"><input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="App.bxSetCfg('${no}','enabled',this.checked)"><span class="toggle-slider"></span></label></td>
        <td>${inp('searchAmount', 110, '—')}</td>
        <td>${inp('offset', 80, '0')}</td>
        <td>${inp('priceLimit', 100, buy ? 'Trần' : 'Sàn')}</td>
        <td>${inp(buy ? 'priceFloor' : 'priceCeiling', 100, buy ? 'Sàn' : 'Trần')}</td>
        <td>${inp('minTrades30d', 70, '0')}</td>
        <td>${inp('minAmount', 100, formatNumber(parseFloat(ad.minAmount)))}</td>
        <td>${inp('maxAmount', 110, formatNumber(parseFloat(ad.maxAmount)))}</td>
        <td class="mono-cell">${Number(ad.priceType) === 2 ? escapeHtml(String(ad.floatRatio)) + '%' : formatNumber(bxCurrentPrice(ad))}</td>
        <td><span class="ap-row-status" id="bx-status-${no}">${escapeHtml(c.lastStatus) || '—'}</span></td>
      </tr>`;
    }).join('');
  }

  function bxSetCfg(no, field, value) {
    const c = state.bxConfigs[no] || (state.bxConfigs[no] = bxDefaultCfg());
    if (field === 'enabled') c.enabled = !!value;
    else c[field] = value === '' ? '' : (isNaN(parseFloat(value)) ? value : parseFloat(value));
    pushAdCfg('bingx', no, { [field]: c[field] });
    renderExSummary();
  }

  async function saveBingxPricer() {
    await pushGlobalSettings('bingx', {
      scanInterval: document.getElementById('bxScanInterval').value,
      marketPages: document.getElementById('bxMarketPages').value,
    });
    autosavedToast();
  }

  function restoreBingxPricerConfig() { refreshEngineState('bingx'); }

  function updateBxApUI() { renderEngineUI('bingx'); }
  function startBingxPricer() { engineStart('bingx'); }
  function stopBingxPricer() { engineStop('bingx'); }

  // ═══════════════════════════════════════════════════════
  // ★ ĐỒNG BỘ VỚI ENGINE TRÊN SERVER (dùng chung với Telegram)
  //   Engine chạy trong server; trình duyệt chỉ điều khiển + hiển thị.
  //   Mọi thay đổi cấu hình gửi lên server và tự lưu; sự kiện realtime qua SSE.
  // ═══════════════════════════════════════════════════════

  const ENGINE_UI = {
    mexc:   { badge: 'apStatusBadge', start: 'apStartBtn', stop: 'apStopBtn', log: 'apLog', interval: 'apScanInterval', statusId: k => `ap-status-${k}` },
    bitget: { badge: 'bgApBadge',     start: 'bgStartBtn', stop: 'bgStopBtn', log: 'bgLog', interval: 'bgScanInterval', statusId: k => `bg-ap-status-${k}` },
    bybit:  { badge: 'byApBadge',     start: 'byStartBtn', stop: 'byStopBtn', log: 'byLog', interval: 'byScanInterval', statusId: k => `by-ap-status-${k}` },
    bingx:  { badge: 'bxApBadge',     start: 'bxStartBtn', stop: 'bxStopBtn', log: 'bxLog', interval: 'bxScanInterval', statusId: k => `bx-status-${k}` },
  };
  const TABLE_BODY = { mexc: 'apTableBody', bitget: 'bgApTableBody', bybit: 'byApTableBody', bingx: 'bxApTableBody' };
  const RENDER_TABLE = { mexc: () => renderAutoPricerTable(), bitget: () => renderBgApRows(), bybit: () => renderByApRows(), bingx: () => renderBingxPricerTable() };

  function timeVN(ts) { return ts ? new Date(ts).toLocaleTimeString('vi-VN', { hour12: false }) : '—'; }

  // ── Log (hiển thị log do engine trên server gửi về) ──
  function appendLog(ex, msg, type = '', at = Date.now()) {
    exActivity(ex, msg, type);
    const box = document.getElementById(ENGINE_UI[ex].log);
    if (!box) return;
    const empty = box.querySelector('.ap-log-empty');
    if (empty) empty.remove();
    const entry = document.createElement('div');
    entry.className = 'ap-log-entry';
    entry.innerHTML = `<span class="ap-log-time">${timeVN(at)}</span><span class="ap-log-msg ${type}">${escapeHtml(msg)}</span>`;
    box.insertBefore(entry, box.firstChild);
    while (box.children.length > 200) box.removeChild(box.lastChild);
  }
  function bgLog(msg, type = '') { appendLog('bitget', msg, type); }
  function byLog(msg, type = '') { appendLog('bybit', msg, type); }

  // ── Trạng thái engine → nút/badge ──
  function renderEngineUI(ex) {
    const st = state.engine[ex];
    const ui = ENGINE_UI[ex];
    const badge = document.getElementById(ui.badge);
    if (st && badge) {
      const map = { running: ['▶ Đang chạy', 'running'], error: ['⚠️ Lỗi — tạm không cập nhật', 'error'], paused: ['⏸ Tạm dừng', 'stopped'] };
      const [txt, cls] = map[st.state] || map.paused;
      badge.textContent = txt;
      badge.className = `ap-status-badge ${cls}`;
      badge.title = st.error || '';
      const s1 = document.getElementById(ui.start), s2 = document.getElementById(ui.stop);
      if (s1) s1.style.display = st.running ? 'none' : 'inline-flex';
      if (s2) s2.style.display = st.running ? 'inline-flex' : 'none';
    }
    renderStrip(ex);
    renderExSummary();
  }

  async function engineStart(ex) {
    const el = document.getElementById(ENGINE_UI[ex].interval);
    const r = await api.post(`/api/engine/${ex}/start`, { scanInterval: el ? el.value : undefined });
    if (r.code !== 0) showToast(r.msg || 'Không bật được auto-pricer', 'error');
    if (r.data) { state.engine[ex] = r.data; renderEngineUI(ex); }
  }
  async function engineStop(ex) {
    const r = await api.post(`/api/engine/${ex}/stop`, {});
    if (r.data) { state.engine[ex] = r.data; renderEngineUI(ex); }
  }

  // ── Áp cấu hình từ server vào state + ô nhập ──
  function setInput(id, v, checkbox = false) {
    const el = document.getElementById(id);
    if (!el || v === undefined || v === null || document.activeElement === el) return;
    if (checkbox) el.checked = !!v; else el.value = v;
  }
  function applyGlobalSettings(ex, s) {
    if (!s) return;
    if (ex === 'mexc') setInput('apScanInterval', s.scanInterval);
    if (ex === 'bitget') { setInput('bgScanInterval', s.scanInterval); setInput('bgOffsetBuy', s.offsetBuy); setInput('bgOffsetSell', s.offsetSell); }
    if (ex === 'bybit') { setInput('byScanInterval', s.scanInterval); setInput('byOnlineOnly', s.onlineOnly !== false, true); }
    if (ex === 'bingx') { setInput('bxScanInterval', s.scanInterval); setInput('bxMarketPages', s.marketPages); }
  }
  function applyEngineState(ex, d) {
    state.engine[ex] = d.status;
    applyGlobalSettings(ex, d.settings);
    const rs = d.rowStatus || {};
    const withStatus = (k, cfg) => ({ ...cfg, lastStatus: rs[k]?.msg || '' });
    if (ex === 'mexc') { state.apConfigs = {}; for (const [k, c] of Object.entries(d.configs || {})) state.apConfigs[k] = withStatus(k, c); }
    if (ex === 'bingx') { state.bxConfigs = {}; for (const [k, c] of Object.entries(d.configs || {})) state.bxConfigs[k] = withStatus(k, c); }
    if (ex === 'bitget') state.bgApRows = (d.rows || []).map(r => withStatus(r.id, r));
    if (ex === 'bybit') state.byApRows = (d.rows || []).map(r => withStatus(r.id, r));
    const box = document.getElementById(ENGINE_UI[ex].log);
    if (box && Array.isArray(d.logs)) {
      box.innerHTML = d.logs.length ? '' : '<div class="ap-log-empty">Chưa có hoạt động nào</div>';
      d.logs.slice().reverse().forEach(e => appendLog(ex, e.msg, e.type, e.at));
    }
    RENDER_TABLE[ex]();
    renderEngineUI(ex);
  }
  async function refreshEngineState(ex) {
    try {
      const r = await api.get(`/api/engine/${ex}/state`);
      if (r.code === 0) applyEngineState(ex, r.data);
    } catch (e) { console.error('[engine state]', e); }
  }
  async function loadEngineState() {
    try {
      const r = await api.get('/api/engine/state');
      if (r.code === 0) for (const ex of Object.keys(ENGINE_UI)) applyEngineState(ex, r.data[ex]);
    } catch (e) { console.error('[engine state]', e); }
  }

  // ── Gửi thay đổi cấu hình 1 ad/dòng lên server ──
  async function pushAdCfg(ex, key, patch) {
    const local = ex === 'mexc' ? state.apConfigs[key] : ex === 'bingx' ? state.bxConfigs[key]
      : (ex === 'bitget' ? state.bgApRows : state.byApRows).find(r => String(r.id) === String(key));
    try {
      const r = await api.post(`/api/engine/${ex}/ads/${encodeURIComponent(key)}`, { patch, expectV: local?._v });
      if (r.code === 0 && r.data) {
        if (local) Object.assign(local, r.data, { lastStatus: local.lastStatus });
        return true;
      }
      showToast(r.code === 409 ? 'Cấu hình vừa được đổi ở nơi khác (Telegram/tab khác) — đã tải lại' : `Không lưu được: ${r.msg || ''}`, r.code === 409 ? 'info' : 'error');
    } catch (err) {
      showToast('Lỗi lưu cấu hình: ' + err.message, 'error');
    }
    await refreshEngineState(ex);   // khôi phục giá trị đúng từ server
    return false;
  }
  async function pushGlobalSettings(ex, patch) {
    const r = await api.post(`/api/engine/${ex}/settings`, patch);
    if (r.code !== 0) showToast('Không lưu được cài đặt: ' + (r.msg || ''), 'error');
  }
  function bindGlobalInputs() {
    const bind = (id, ex, field, getter = el => el.value) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => pushGlobalSettings(ex, { [field]: getter(el) }));
    };
    bind('apScanInterval', 'mexc', 'scanInterval');
    bind('bgScanInterval', 'bitget', 'scanInterval');
    bind('bgOffsetBuy', 'bitget', 'offsetBuy');
    bind('bgOffsetSell', 'bitget', 'offsetSell');
    bind('byScanInterval', 'bybit', 'scanInterval');
    bind('byOnlineOnly', 'bybit', 'onlineOnly', el => el.checked);
    bind('bxScanInterval', 'bingx', 'scanInterval');
    bind('bxMarketPages', 'bingx', 'marketPages');
  }
  function autosavedToast() { showToast('Cấu hình được tự động lưu ngay khi thay đổi (dùng chung với Telegram)', 'info'); }

  // ── Sự kiện realtime từ server ──
  const pendingRender = {};
  function rerenderTable(ex) {
    const body = document.getElementById(TABLE_BODY[ex]);
    // Đang gõ trong bảng → chờ rời ô rồi mới vẽ lại, tránh mất chữ đang nhập
    if (body && body.contains(document.activeElement)) {
      if (!pendingRender[ex]) {
        pendingRender[ex] = true;
        document.activeElement.addEventListener('blur', () => { pendingRender[ex] = false; setTimeout(() => RENDER_TABLE[ex](), 50); }, { once: true });
      }
      return;
    }
    RENDER_TABLE[ex]();
  }
  function onConfigEvent(ev) {
    const { ex } = ev;
    if (!ENGINE_UI[ex]) return;
    if (ev.scope === 'settings') { applyGlobalSettings(ex, ev.settings); return; }
    if (ev.scope === 'removed') {
      if (ex === 'bitget') state.bgApRows = state.bgApRows.filter(r => String(r.id) !== String(ev.key));
      if (ex === 'bybit') state.byApRows = state.byApRows.filter(r => String(r.id) !== String(ev.key));
      rerenderTable(ex); return;
    }
    const keep = c => (c ? c.lastStatus : '');
    if (ex === 'mexc') state.apConfigs[ev.key] = { ...ev.cfg, lastStatus: keep(state.apConfigs[ev.key]) };
    else if (ex === 'bingx') state.bxConfigs[ev.key] = { ...ev.cfg, lastStatus: keep(state.bxConfigs[ev.key]) };
    else {
      const rows = ex === 'bitget' ? state.bgApRows : state.byApRows;
      const i = rows.findIndex(r => String(r.id) === String(ev.key));
      if (i >= 0) rows[i] = { ...ev.cfg, lastStatus: keep(rows[i]) }; else rows.push({ ...ev.cfg, lastStatus: '' });
    }
    if (ev.client !== CLIENT_ID) {
      rerenderTable(ex);
      if (ev.source === 'telegram') showToast(`${EX_LABEL[ex]}: cấu hình vừa được đổi từ Telegram`, 'info');
    }
    renderExSummary();
  }
  function onRowStatus(ev) {
    const ui = ENGINE_UI[ev.ex]; if (!ui) return;
    const el = document.getElementById(ui.statusId(ev.key));
    if (el) { el.textContent = ev.msg; el.className = `ap-row-status${ev.type ? ' ' + ev.type : ''}`; }
    const cfg = ev.ex === 'mexc' ? state.apConfigs[ev.key] : ev.ex === 'bingx' ? state.bxConfigs[ev.key]
      : (ev.ex === 'bitget' ? state.bgApRows : state.byApRows).find(r => String(r.id) === String(ev.key));
    if (cfg) cfg.lastStatus = ev.msg;
  }

  // Ads của tôi: lấy từ cache của engine (không gọi lại sàn)
  const adsTimers = {};
  function onAdsEvent(ev) {
    clearTimeout(adsTimers[ev.ex]);
    adsTimers[ev.ex] = setTimeout(() => syncAdsFromEngine(ev.ex), 400);
  }
  async function syncAdsFromEngine(ex) {
    try {
      const r = await api.get(`/api/engine/${ex}/raw-ads`);
      if (r.code !== 0) return;
      const list = r.data || [];
      const idsOf = (arr, f) => arr.map(f).sort().join(',');
      if (ex === 'mexc' && state.connected) {
        const changed = idsOf(list, a => a.advNo || a.davNo) !== idsOf(state.myAds, a => a.advNo || a.davNo);
        state.myAds = list;
        state.myAdvNos = new Set(list.map(a => a.advNo || a.davNo || '').filter(Boolean));
        applyMyAdsFilter();
        if (changed) rerenderTable('mexc');
      }
      if (ex === 'bitget' && state.bgConnected) { state.bgAds = list; renderBgAdsTable(); }
      if (ex === 'bybit' && state.byConnected) { state.byAds = list; renderBybitAds(); }
      if (ex === 'bingx' && state.bxConnected) {
        const changed = idsOf(list, a => String(a.advertNo)) !== idsOf(state.bxAds, a => String(a.advertNo));
        state.bxAds = list; state.bxAdvNos = new Set(list.map(a => String(a.advertNo)));
        renderBingxAds();
        if (changed) rerenderTable('bingx');
      }
    } catch (_) {}
  }

  let evtSource = null;
  function connectEvents() {
    if (!window.EventSource) return;
    evtSource = new EventSource('/api/events');
    const on = (name, fn) => evtSource.addEventListener(name, e => { try { fn(JSON.parse(e.data)); } catch (err) { console.error('[SSE]', name, err); } });
    on('hello', () => { loadEngineState(); loadTelegram(); loadMarketFilters(); });   // (kết nối lại) → nạp lại toàn bộ trạng thái
    on('engine', st => { state.engine[st.ex] = st; renderEngineUI(st.ex); });
    on('log', e => { if (ENGINE_UI[e.ex]) appendLog(e.ex, e.msg, e.type, e.at); });
    on('rowStatus', onRowStatus);
    on('config', onConfigEvent);
    on('ads', onAdsEvent);
    on('market', e => { state.best[e.ex] = { ...(state.best[e.ex] || {}), ...e.best }; renderStrip(e.ex); });
    on('telegram', renderTelegramStatus);
    on('marketFilter', onMarketFilterEvent);
    on('audit', e => { state.audit.unshift(e); state.audit = state.audit.slice(0, 100); renderAudit(); });
    evtSource.onerror = () => { document.body.classList.add('sse-offline'); };
    evtSource.onopen = () => { document.body.classList.remove('sse-offline'); };
  }

  // ── Thanh trạng thái & giá đầu mỗi tab ──
  function marketFreshness(ex) {
    const st = state.engine[ex] || {};
    const b = state.best[ex] || {};
    const lastOk = Math.max(b.error ? 0 : (b.at || 0), st.marketStatus?.lastOkAt || 0) || null;
    const limit = Math.max(90, (st.interval || 30) * 3) * 1000;
    const stale = !lastOk || Date.now() - lastOk > limit;
    return { lastOk, stale, error: b.error || st.marketStatus?.lastError || null };
  }
  function renderStrip(ex) {
    const el = document.getElementById(`exStrip-${ex}`);
    if (!el) return;
    const st = state.engine[ex];
    if (!st) { el.innerHTML = '<div class="ex-strip-loading">Đang tải trạng thái...</div>'; return; }
    const b = state.best[ex] || {};
    const f = marketFreshness(ex);
    const conn = st.connected
      ? `<span class="ex-pill ok">● Đã kết nối</span>${ex === 'mexc' ? ` <span class="ex-pill ${st.market?.ok ? 'ok' : 'off'}" title="API phụ dùng để lấy market">${st.market?.ok ? '● API phụ' : '○ API phụ'}</span>` : ''}`
      : '<span class="ex-pill off">○ Chưa kết nối</span>';
    const run = { running: '<span class="ex-pill run">▶ Running</span>', paused: '<span class="ex-pill off">⏸ Paused</span>', error: '<span class="ex-pill err">⚠️ Error</span>' }[st.state];
    const price = v => (v === null || v === undefined ? '—' : formatNumber(v));
    const amt = parseFloat(document.getElementById('pbAmount')?.value) || 0;
    const warns = [];
    if (st.state === 'error' && st.error) warns.push(`Engine tạm ngừng cập nhật giá: ${escapeHtml(st.error)}`);
    if (st.connected && f.stale) warns.push(`Giá thị trường có thể đã cũ${f.lastOk ? ` (lần lấy thành công cuối: ${timeVN(f.lastOk)})` : ''}${f.error ? ` — ${escapeHtml(f.error)}` : ''}`);
    el.innerHTML = `
      <div class="exs-row">
        <div class="exs-name">${EX_LABEL[ex]}</div>
        <div class="exs-item"><label>API</label><div>${conn}</div></div>
        <div class="exs-item"><label>Auto Pricing</label><div>${run} <span class="ex-sub">${st.enabledCount} ad bật · ${st.interval}s</span></div></div>
        <div class="exs-item"><label>Best BUY</label><div class="mono-cell price-value price-buy">${price(b.buy)}</div></div>
        <div class="exs-item"><label>Best SELL</label><div class="mono-cell price-value price-sell">${price(b.sell)}</div></div>
        <div class="exs-item"><label>Market cập nhật</label><div class="mono-cell ${f.stale ? 'exs-stale' : ''}">${timeVN(f.lastOk)}</div></div>
        <div class="exs-item"><label>Đổi giá gần nhất</label><div class="mono-cell">${timeVN(st.lastPriceUpdateAt)} <span class="ex-sub">${st.updates} lần</span></div></div>
        <div class="exs-actions">
          ${st.running ? `<button class="btn btn-danger btn-sm" onclick="App.engineStop('${ex}')">⏸ Dừng</button>` : `<button class="btn btn-primary btn-sm" onclick="App.engineStart('${ex}')" ${st.connected ? '' : 'disabled title="Chưa kết nối sàn"'}>▶ Bật</button>`}
          ${st.connected ? '' : `<button class="btn btn-ghost btn-sm" onclick="App.scrollToConnect('${ex}')">Kết nối ↓</button>`}
        </div>
      </div>
      <div class="exs-note">Best BUY = giá cao nhất của ads MUA · Best SELL = giá thấp nhất của ads BÁN${amt > 0 ? ` · lọc theo số tiền ${formatNumber(amt)} VND` : ''} · bỏ ads của bạn + whitelist</div>
      ${warns.length ? `<div class="exs-warn">⚠️ ${warns.join('<br>⚠️ ')}</div>` : ''}`;
  }
  function scrollToConnect(ex) {
    const id = { mexc: 'mexcConnectCard', bitget: 'bitgetCard', bybit: 'bybitCard', bingx: 'bingxCard' }[ex];
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Market — ads đối thủ (mỗi tab) ──
  function mkSetSide(ex, side) {
    state.mk[ex] = { ...(state.mk[ex] || {}), side };
    document.querySelectorAll(`#mkCard-${ex} .mk-chip`).forEach(c => c.classList.toggle('active', c.dataset.side === side));
    mkLoad(ex);
  }
  async function mkLoad(ex, fresh = false) {
    const mk = state.mk[ex] || (state.mk[ex] = { side: 'BUY' });
    const body = document.getElementById(`mkBody-${ex}`);
    const info = document.getElementById(`mkInfo-${ex}`);
    if (!body) return;
    const minQty = parseFloat(document.getElementById(`mkMinQty-${ex}`)?.value) || 0;
    mk.loadedAt = Date.now();
    if (info) info.textContent = 'Đang tải...';
    try {
      const r = await api.get(`/api/market/list?ex=${ex}&side=${mk.side}&minQty=${minQty}${fresh ? '&fresh=1' : ''}`);
      if (r.code !== 0) {
        body.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state"><p>${escapeHtml(r.msg || 'Không lấy được market')}</p></div></td></tr>`;
        if (info) info.textContent = '';
        return;
      }
      const d = r.data;
      if (info) info.textContent = `${d.items.length}/${d.total} ads · ${timeVN(d.at)}${d.cached ? ' (cache)' : ''} · ${mk.side === 'BUY' ? 'giá cao → thấp' : 'giá thấp → cao'}`;
      if (!d.items.length) { body.innerHTML = '<tr class="empty-row"><td colspan="7"><div class="empty-state"><p>Không có ads khớp bộ lọc</p></div></td></tr>'; return; }
      body.innerHTML = d.items.slice(0, 30).map((m, i) => `<tr>
        <td class="mono-cell text-muted">${i + 1}</td>
        <td>${escapeHtml(m.name)}</td>
        <td class="mono-cell price-value ${mk.side === 'BUY' ? 'price-buy' : 'price-sell'}">${formatNumber(m.price)}</td>
        <td class="mono-cell">${m.available !== null ? formatNumber(m.available) : '—'}</td>
        <td class="mono-cell">${formatNumber(m.min)} – ${formatNumber(m.max)}</td>
        <td><span class="payment-badge">${escapeHtml((m.payments || []).slice(0, 3).join(', ') || '—')}</span></td>
        <td class="mono-cell">${m.completion !== null && m.completion !== undefined ? (m.completion * 100).toFixed(1) + '%' : '—'}</td>
      </tr>`).join('');
    } catch (err) {
      body.innerHTML = `<tr class="empty-row"><td colspan="7"><div class="empty-state"><p>${escapeHtml(err.message)}</p></div></td></tr>`;
    }
  }

  // Bộ lọc SL khả dụng tối thiểu — riêng từng sàn, lưu trên server, dùng chung với Telegram
  async function loadMarketFilters() {
    try {
      const r = await api.get('/api/market/filters');
      if (r.code === 0) for (const [ex, v] of Object.entries(r.data)) setInput(`mkMinQty-${ex}`, v);
    } catch (_) {}
  }
  async function mkSetMinQty(ex) {
    const el = document.getElementById(`mkMinQty-${ex}`);
    const v = parseFloat(el?.value) || 0;
    const r = await api.post(`/api/market/filters/${ex}`, { minQty: v });
    if (r.code !== 0) { showToast(r.msg || 'Không lưu được bộ lọc', 'error'); loadMarketFilters(); return; }
    mkLoad(ex);
  }
  function onMarketFilterEvent(ev) {
    setInput(`mkMinQty-${ev.ex}`, ev.minQty);
    if (ev.client !== CLIENT_ID) {
      if (state.mk[ev.ex]?.loadedAt) mkLoad(ev.ex);
      if (ev.source === 'telegram') showToast(`${EX_LABEL[ev.ex]}: bộ lọc SL tối thiểu = ${formatNumber(ev.minQty)} USDT (từ Telegram)`, 'info');
    }
  }

  // ── Telegram ──
  async function loadTelegram() {
    try {
      const r = await api.get('/api/telegram/status');
      if (r.code !== 0) return;
      const d = r.data;
      setInput('tgUserId', d.userId);
      setInput('tgChatId', d.chatId);
      setInput('tgEnabled', d.enabled, true);
      renderTelegramStatus(d);
    } catch (_) {}
  }
  function renderTelegramStatus(d) {
    state.telegram = d;
    const dot = document.getElementById('tgStatusDot'), txt = document.getElementById('tgStatusText');
    const tok = document.getElementById('tgToken'), hint = document.getElementById('tgTokenHint');
    const box = document.getElementById('tgStatusBox');
    const ok = d.connected, on = d.enabled;
    if (dot) dot.className = 'status-dot' + (ok ? ' connected' : '');
    if (txt) txt.textContent = !d.hasToken ? 'Chưa cấu hình' : !on ? 'Đã tắt' : ok ? `Đang chạy · @${d.botUsername || ''}` : (d.lastError ? 'Lỗi kết nối' : 'Đang kết nối...');
    if (tok) tok.placeholder = d.hasToken ? '•••••• Đã lưu token — để trống nếu không đổi' : 'Dán token từ @BotFather';
    if (hint) hint.textContent = d.hasToken ? 'Token đã lưu trên máy chạy app (không hiển thị lại). Nhập token mới để thay.' : 'Token chỉ lưu trên máy chạy app, không bao giờ hiển thị lại trên trình duyệt.';
    if (box) box.innerHTML = `
      <div><b>Trạng thái:</b> ${!on ? '⏸ Bot đang tắt' : ok ? '🟢 Đang nhận lệnh (long polling)' : d.running ? '🟡 Đang kết nối lại...' : '🔴 Không chạy'}</div>
      ${d.lastOkAt ? `<div><b>Liên lạc Telegram gần nhất:</b> ${timeVN(d.lastOkAt)}</div>` : ''}
      ${d.lastError ? `<div class="exs-warn">⚠️ ${escapeHtml(d.lastError)} (${timeVN(d.lastErrorAt)})</div>` : ''}
      <div class="ex-sub">Telegram mất kết nối không ảnh hưởng auto-pricer — engine vẫn chạy bình thường.</div>`;
    const tdot = document.getElementById('exDot-telegram');
    if (tdot) tdot.className = 'ex-dot' + (ok ? ' on' : '');
  }
  async function saveTelegram() {
    const body = {
      botToken: document.getElementById('tgToken').value.trim(),
      userId: document.getElementById('tgUserId').value.trim(),
      chatId: document.getElementById('tgChatId').value.trim(),
      enabled: document.getElementById('tgEnabled').checked,
    };
    if (body.enabled && (!body.userId || !body.chatId)) { showToast('Cần nhập User ID và Chat ID được phép trước khi bật bot', 'error'); return; }
    setLoading(true, 'tgSaveBtn');
    try {
      const r = await api.post('/api/telegram/config', body);
      if (r.code === 0) { document.getElementById('tgToken').value = ''; renderTelegramStatus(r.data); showToast('Đã lưu cấu hình Telegram', 'success'); }
      else showToast(r.msg || 'Lỗi lưu', 'error');
    } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
    finally { setLoading(false, 'tgSaveBtn'); }
  }
  async function testTelegram() {
    setLoading(true, 'tgTestBtn');
    try {
      const r = await api.post('/api/telegram/test', {});
      showToast(r.msg || (r.code === 0 ? 'OK' : 'Thất bại'), r.code === 0 ? 'success' : 'error');
      if (r.data) renderTelegramStatus(r.data);
    } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
    finally { setLoading(false, 'tgTestBtn'); }
  }

  // ── Nhật ký thay đổi ──
  async function loadAudit() {
    try {
      const r = await api.get('/api/audit?limit=100');
      if (r.code === 0) { state.audit = r.data || []; renderAudit(); }
    } catch (_) {}
  }
  function renderAudit() {
    const body = document.getElementById('auditBody');
    if (!body) return;
    if (!state.audit.length) { body.innerHTML = '<tr class="empty-row"><td colspan="9"><div class="empty-state"><p>Chưa có thay đổi nào</p></div></td></tr>'; return; }
    const show = v => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? escapeHtml(JSON.stringify(v)) : escapeHtml(String(v)));
    const src = { telegram: '📱 Telegram', web: '🖥 Web', engine: '⚙️ Engine', system: 'Hệ thống' };
    body.innerHTML = state.audit.map(e => `<tr>
      <td class="mono-cell text-muted">${new Date(e.ts).toLocaleString('vi-VN', { hour12: false })}</td>
      <td>${escapeHtml(EX_LABEL[e.exchange] || e.exchange || '—')}</td>
      <td class="mono-cell" title="${escapeHtml(e.adId || '')}">${e.adId ? truncateId(e.adId) : '—'}</td>
      <td>${escapeHtml(e.parameter || '—')}</td>
      <td class="mono-cell">${show(e.previous)}</td>
      <td class="mono-cell">${show(e.next)}</td>
      <td>${src[e.source] || escapeHtml(e.source || '')}</td>
      <td><span class="ex-pill ${e.status === 'success' ? 'ok' : 'err'}">${escapeHtml(e.status)}</span>${e.message ? `<div class="ex-sub">${escapeHtml(e.message)}</div>` : ''}</td>
      <td class="mono-cell text-muted">${show(e.exchangeStatus)}</td>
    </tr>`).join('');
  }

  // ─── Khởi tạo ────────────────────────────────────────
  async function init() {
    // ★ MỚI: Load whitelist ngay khi khởi động (không cần kết nối)
    restoreActiveExchange();     // ★ mở lại tab sàn đã chọn lần trước
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
    await loadMexcAdText(false);   // ★ nội dung Automated Reply / Advertiser Terms
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

    if (status.data?.bingxConnected) {
      state.bxConnected = true;
      updateBxConnectionUI(true);
      restoreBingxPricerConfig();
      await loadBingxAds(true);
    }

    if (status.data?.bybitConnected) {
      state.byConnected = true;
      updateBybitUI(true);
      await loadBybitAds();
      restoreBybitPricerConfig();   // ★
    }

    const config = await api.get('/api/config');
    if (config.data?.apiHosts) {
      const hosts = config.data.apiHosts.map(h => `<option value="${h.value}">${h.label}</option>`).join('');
      document.getElementById('apiHost').innerHTML = hosts;
      document.getElementById('apiHost2').innerHTML = hosts;
    }

    renderBgApRows();
    // ★ Engine trên server: nạp trạng thái + cấu hình dùng chung, nghe sự kiện realtime
    bindGlobalInputs();
    await loadEngineState();
    connectEvents();
    loadTelegram();
    renderExSummary();
    setInterval(renderExSummary, 1000);   // bảng trạng thái các sàn
    setInterval(() => Object.keys(ENGINE_UI).forEach(renderStrip), 10000);   // cập nhật cảnh báo "dữ liệu cũ"
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
    byApAddRow, 
    byApRemoveRow,
    byApSetRow,
    startBybitPricer,
    stopBybitPricer, 
    saveBybitPricer,
    loadMexcAdText,
    saveMexcAdText,
    resetMexcAdText,
    mexcAdTextPreview,
    // ★ Tab sàn + BingX
    switchExchange,
    connectBingx,
    disconnectBingx,
    diagnoseBingx,
    saveBingxCreds,
    loadBingxAds,
    filterBingxAds,
    bxSetCfg,
    startBingxPricer,
    stopBingxPricer,
    saveBingxPricer,
    clearBingxLog,
    // ★ Engine server + Telegram
    engineStart,
    engineStop,
    scrollToConnect,
    mkSetSide,
    mkLoad,
    mkSetMinQty,
    saveTelegram,
    testTelegram,
    loadAudit,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
