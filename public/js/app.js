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
  };

  // Timer auto-refresh (handle của setInterval)
  let autoRefreshTimer = null;

  // ★ MỚI: Binance price polling
  let bnPriceTimer = null;
  let bnCountdown = 60;

  // ★ MỚI: Bitget auto-pricer timer
  let bgApTimer = null;

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

  // ═══════════════════════════════════════════════════════
  // ★ MỚI: BITGET P2P
  // ═══════════════════════════════════════════════════════

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
      } else {
        showToast(r.msg || 'Bitget kết nối thất bại', 'error');
      }
    } catch (err) { showToast('Lỗi: ' + err.message, 'error'); }
    finally { setLoading(false, 'bgConnectBtn'); }
  }

  async function disconnectBitget() {
    await api.post('/api/bitget/disconnect');
    state.bgConnected = false;
    state.bgAds = [];
    state.bgApConfigs = {};
    if (bgApTimer) { clearInterval(bgApTimer); bgApTimer = null; }
    updateBgConnectionUI(false);
    renderBgAdsTable();
    renderBgApTable();
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
      const r = await api.get('/api/bitget/ads?limit=20');
      if (r.code === '00000') {
        state.bgAds = r.data?.advList || [];
        renderBgAdsTable();
        renderBgApTable();
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
    tbody.innerHTML = state.bgAds.map(ad => {
      const isBuy = ad.type === 'buy';
      const isOnline = ad.status === 'online';
      return `<tr class="ad-row ${isOnline ? '' : 'ad-closed'}">
        <td class="mono-cell">${truncateId(ad.advNo || ad.advId || '')}</td>
        <td><span class="side-badge ${isBuy ? 'side-buy' : 'side-sell'}">${isBuy ? 'MUA' : 'BÁN'}</span></td>
        <td><span class="status-badge ${isOnline ? 'status-open' : 'status-closed'}"><span class="status-indicator"></span>${isOnline ? 'Online' : 'Offline'}</span></td>
        <td>${ad.coin || 'USDT'}</td>
        <td class="mono-cell price-value ${isBuy ? 'price-buy' : 'price-sell'}">${formatNumber(ad.price)}</td>
        <td class="mono-cell">${formatNumber(ad.amount)}</td>
        <td class="mono-cell">${formatNumber(ad.minAmount)} - ${formatNumber(ad.maxAmount)}</td>
        <td>${ad.fiatCode || ''}</td>
      </tr>`;
    }).join('');
  }

  function renderBgApTable() {
    const tbody = document.getElementById('bgApTableBody');
    if (!tbody) return;
    if (!state.bgAds.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="ap-empty">Kết nối Bitget để cấu hình</td></tr>';
      return;
    }
    tbody.innerHTML = state.bgAds.filter(a => a.status === 'online').map(ad => {
      const advKey = ad.advNo || ad.advId || '';
      if (!state.bgApConfigs[advKey]) {
        state.bgApConfigs[advKey] = { enabled: false, priceLimit: '', lastStatus: '' };
      }
      const c = state.bgApConfigs[advKey];
      const isBuy = ad.type === 'buy';
      return `<tr>
        <td><span class="mono-cell" style="font-size:11px">${truncateId(advKey)}</span>
            <span class="side-badge ${isBuy ? 'side-buy' : 'side-sell'}" style="font-size:10px;margin-left:6px">${isBuy ? 'BUY' : 'SELL'}</span></td>
        <td><label class="toggle"><input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="App.bgApToggle('${advKey}',this.checked)"><span class="toggle-slider"></span></label></td>
        <td><input type="number" class="ap-num-input" value="${c.priceLimit}" placeholder="${isBuy ? 'Trần' : 'Sàn'}" onchange="App.bgApSetLimit('${advKey}',this.value)"></td>
        <td><span class="ap-row-status" id="bg-status-${advKey}">${c.lastStatus || '—'}</span></td>
      </tr>`;
    }).join('');
  }

  function bgApToggle(advKey, enabled) {
    if (state.bgApConfigs[advKey]) state.bgApConfigs[advKey].enabled = enabled;
  }
  function bgApSetLimit(advKey, val) {
    if (state.bgApConfigs[advKey]) state.bgApConfigs[advKey].priceLimit = val;
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
    if (!state.bgAds.length) return;
    const offsetBuy = parseFloat(document.getElementById('bgOffsetBuy').value) || -50;
    const offsetSell = parseFloat(document.getElementById('bgOffsetSell').value) || 50;

    for (const ad of state.bgAds) {
      const advKey = ad.advNo || ad.advId || '';
      const cfg = state.bgApConfigs[advKey];
      if (!cfg || !cfg.enabled || ad.status !== 'online') continue;

      const isBuy = ad.type === 'buy';
      const statusEl = document.getElementById(`bg-status-${advKey}`);

      try {
        if (statusEl) { statusEl.textContent = 'Đang quét...'; statusEl.className = 'ap-row-status'; }

        // Lấy giá Binance hiện tại từ card bnPriceValue
        const bnPriceEl = document.getElementById('bnPriceValue');
        const bnPriceText = bnPriceEl ? bnPriceEl.textContent.replace(/[.,\s]/g, '') : '';
        const bnPrice = parseFloat(bnPriceText);

        if (!bnPrice || bnPrice < 100) {
          if (statusEl) { statusEl.textContent = 'Chờ giá Binance'; statusEl.className = 'ap-row-status warn'; }
          bgLog(`[${truncateId(advKey)}] Chưa có giá Binance`, 'warn');
          continue;
        }

        // Tính giá mới = giá Binance + offset
        let newPrice = isBuy ? bnPrice + offsetBuy : bnPrice + offsetSell;

        // Áp trần/sàn
        if (cfg.priceLimit) {
          const lim = parseFloat(cfg.priceLimit);
          if (isBuy && newPrice > lim) newPrice = lim;
          if (!isBuy && newPrice < lim) newPrice = lim;
        }

        newPrice = Math.round(newPrice);
        const currentPrice = parseFloat(ad.price);

        if (newPrice === currentPrice) {
          if (statusEl) { statusEl.textContent = `Giá OK: ${formatNumber(currentPrice)}`; statusEl.className = 'ap-row-status ok'; }
          continue;
        }

        // Gọi Bitget Update Ad API
        const payload = {
          advNo: ad.advNo || ad.advId,
          price: String(newPrice),
          coin: ad.coin || 'USDT',
          fiatCode: ad.fiatCode || 'VND',
          type: ad.type,
          amount: ad.amount,
          minAmount: ad.minAmount,
          maxAmount: ad.maxAmount,
          status: 'online',
        };

        const result = await api.post('/api/bitget/ads/update', payload);

        if (result.code === '00000') {
          ad.price = String(newPrice);
          if (statusEl) { statusEl.textContent = `→ ${formatNumber(newPrice)}`; statusEl.className = 'ap-row-status ok'; }
          bgLog(`[${truncateId(advKey)}] ${ad.type.toUpperCase()} | Binance: ${formatNumber(bnPrice)} → Mới: ${formatNumber(newPrice)}`, 'success');
          cfg.lastStatus = `→ ${formatNumber(newPrice)}`;
        } else {
          if (statusEl) { statusEl.textContent = `Lỗi: ${result.msg}`; statusEl.className = 'ap-row-status err'; }
          bgLog(`[${truncateId(advKey)}] Lỗi: ${result.msg}`, 'error');
        }
      } catch (err) {
        if (statusEl) { statusEl.textContent = `Lỗi: ${err.message}`; statusEl.className = 'ap-row-status err'; }
        bgLog(`[${truncateId(advKey)}] ${err.message}`, 'error');
      }
    }
  }

  function startBitgetPricer() {
    if (bgApTimer) return;
    const interval = Math.max(5, parseInt(document.getElementById('bgScanInterval').value) || 30) * 1000;
    document.getElementById('bgApBadge').textContent = '▶ Đang chạy';
    document.getElementById('bgApBadge').className = 'ap-status-badge running';
    document.getElementById('bgStartBtn').style.display = 'none';
    document.getElementById('bgStopBtn').style.display = 'inline-flex';
    bgLog(`Bitget auto-pricer bắt đầu — quét mỗi ${interval / 1000}s`, 'success');
    bgRunCycle();
    bgApTimer = setInterval(bgRunCycle, interval);
  }

  function stopBitgetPricer() {
    if (bgApTimer) { clearInterval(bgApTimer); bgApTimer = null; }
    document.getElementById('bgApBadge').textContent = '⏹ Đã dừng';
    document.getElementById('bgApBadge').className = 'ap-status-badge stopped';
    document.getElementById('bgStartBtn').style.display = 'inline-flex';
    document.getElementById('bgStopBtn').style.display = 'none';
    bgLog('Bitget auto-pricer đã dừng', 'warn');
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

    // ★ MỚI: Bắt đầu polling giá Binance
    startBinancePricePolling();

    const status = await api.get('/api/status');
    if (status.data?.connected) {
      state.connected = true;
      updateConnectionUI(true, '');
      await loadMyAds();
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
    }

    const config = await api.get('/api/config');
    if (config.data?.apiHosts) {
      const hosts = config.data.apiHosts.map(h => `<option value="${h.value}">${h.label}</option>`).join('');
      document.getElementById('apiHost').innerHTML = hosts;
      document.getElementById('apiHost2').innerHTML = hosts;
    }
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
    bgApToggle,
    bgApSetLimit,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
