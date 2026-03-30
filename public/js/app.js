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
    // startPage: trang API đầu tiên của batch hiện tại
    // fetchedUpTo: trang API cuối cùng đã fetch trong batch
    // total: tổng số trang API
    // history: stack startPage của các batch trước (để "Prev" quay lại)
    buyPage: { startPage: 1, fetchedUpTo: 1, total: 1, history: [] },
    sellPage: { startPage: 1, fetchedUpTo: 1, total: 1, history: [] },
    fiatUnit: 'VND',

    // ── Bộ lọc Market Ads ──
    marketFilters: {
      onlineMinutes: 0,   // 0 = không lọc; >0 = merchant phải online trong X phút gần đây
      amount: 0,          // 0 = không lọc; >0 = số lượng phải nằm trong giới hạn merchant
      autoRefreshSec: 0,  // 0 = tắt; >0 = tự động làm mới mỗi X giây
    },

    // ── My Ads state ──
    myAds: [],
    myAdsFiltered: [],
    myAdsFilter: 'ALL',
    myAdsPage: { current: 1, total: 1 },
  };

  // Timer auto-refresh (handle của setInterval)
  let autoRefreshTimer = null;

  // ─── API Client: Gửi request đến backend ─────────────
  const api = {
    /** Gửi POST request với body JSON */
    async post(url, data) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      return res.json();
    },

    /** Gửi GET request */
    async get(url) {
      const res = await fetch(url);
      return res.json();
    },
  };

  // ─── Kết nối / Ngắt kết nối ──────────────────────────

  /**
   * Kết nối đến MEXC API.
   * Lấy apiKey, secretKey, apiHost từ form input,
   * gửi POST /api/connect để backend tạo service instance.
   * Nếu thành công, tự động load My Ads + Market Ads.
   */
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
        // Tự động tải tất cả dữ liệu sau khi kết nối
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

  /**
   * Ngắt kết nối API.
   * Gọi POST /api/disconnect, xóa toàn bộ dữ liệu, cập nhật giao diện.
   */
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

  /**
   * Kết nối API phụ dùng để lấy Market Ads.
   * Lấy apiKey2, secretKey2, apiHost2 từ form input,
   * gửi POST /api/connect/secondary.
   * Nếu thành công, tự động load Market Ads.
   */
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

  /**
   * Ngắt kết nối API phụ.
   * Xóa dữ liệu Market Ads và cập nhật giao diện.
   */
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

  /**
   * Cập nhật giao diện card kết nối phụ.
   * @param {boolean} connected - Trạng thái kết nối phụ
   * @param {string} host - Tên host đang kết nối
   */
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

  /**
   * Lấy tất cả quảng cáo của bản thân từ API.
   * Gọi 2 lần: 1 lần lấy ads OPEN, 1 lần lấy ads CLOSE.
   * Gộp kết quả lại để hiển thị đầy đủ cả 2 trạng thái.
   * @param {number} page - Số trang (mặc định 1)
   */
  async function loadMyAds(page = 1) {
    if (!state.connected) return;

    setMyAdsLoading(true);

    try {
      // Gọi API lấy ads với advStatus=OPEN,CLOSE (tất cả trạng thái)
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
        // Áp dụng filter hiện tại
        applyMyAdsFilter();
      } else {
        showToast(`Lỗi lấy ads cá nhân: ${result.msg}`, 'error');
      }
    } catch (err) {
      showToast(`Lỗi: ${err.message}`, 'error');
    } finally {
      setMyAdsLoading(false);
    }
  }

  /**
   * Lọc danh sách My Ads theo trạng thái (ALL / OPEN / CLOSE).
   * Cập nhật state.myAdsFiltered rồi render lại bảng.
   * @param {string} filter - 'ALL', 'OPEN', hoặc 'CLOSE'
   */
  function filterMyAds(filter) {
    state.myAdsFilter = filter;

    // Cập nhật UI filter chips
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === filter);
    });

    applyMyAdsFilter();
  }

  /**
   * Áp dụng bộ lọc hiện tại lên danh sách My Ads.
   * Lọc từ state.myAds → state.myAdsFiltered, rồi render bảng.
   */
  function applyMyAdsFilter() {
    if (state.myAdsFilter === 'ALL') {
      state.myAdsFiltered = [...state.myAds];
    } else {
      // So sánh advStatus (có thể là "open", "OPEN", "close", "CLOSE")
      state.myAdsFiltered = state.myAds.filter(ad => {
        const status = (ad.advStatus || '').toUpperCase();
        return status === state.myAdsFilter;
      });
    }
    renderMyAdsTable();
  }

  /**
   * Render bảng quảng cáo cá nhân (My Ads).
   * Hiển thị: mã QC, loại (BUY/SELL), trạng thái, coin, giá,
   * số lượng khả dụng/tổng, giới hạn, fiat, thanh toán, ngày tạo.
   */
  function renderMyAdsTable() {
    const ads = state.myAdsFiltered;
    const container = document.getElementById('myAdsTableBody');
    if (!container) return;

    // Cập nhật counter trên filter chips
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

      // Tính số lượng: quantity = initAmount / price
      const quantity = ad.quantity || (ad.initAmount && ad.price ? (ad.initAmount / ad.price).toFixed(4) : '—');

      // Lấy tên payment methods từ paymentInfo array
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

  /**
   * Cập nhật số lượng ads trên mỗi filter chip.
   * Ví dụ: "Tất cả (5)", "Đang mở (3)", "Đã đóng (2)"
   */
  function updateMyAdsCounters() {
    const all = state.myAds.length;
    const open = state.myAds.filter(a => (a.advStatus || '').toUpperCase() === 'OPEN').length;
    const closed = state.myAds.filter(a => (a.advStatus || '').toUpperCase() === 'CLOSE').length;

    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(chip => {
      const filter = chip.dataset.filter;
      const count = filter === 'ALL' ? all : filter === 'OPEN' ? open : closed;
      // Chỉ thêm counter nếu đã kết nối và có data
      if (state.connected && all > 0) {
        const label = chip.textContent.replace(/\s*\(\d+\)/, '').trim();
        chip.textContent = `${label} (${count})`;
      }
    });
  }

  /**
   * Bật/tắt loading overlay cho bảng My Ads.
   * @param {boolean} loading - true = đang tải
   */
  function setMyAdsLoading(loading) {
    const wrapper = document.getElementById('myAdsTableWrapper');
    if (!wrapper) return;
    wrapper.classList.toggle('my-ads-loading', loading);
  }

  /**
   * Chuyển trang cho My Ads.
   * @param {number} direction - +1 (trang sau) hoặc -1 (trang trước)
   */
  async function changeMyAdsPage(direction) {
    const newPage = state.myAdsPage.current + direction;
    if (newPage < 1 || newPage > state.myAdsPage.total) return;
    await loadMyAds(newPage);
  }

  // ═══════════════════════════════════════════════════════
  // MARKET ADS — Quảng cáo trên thị trường
  // ═══════════════════════════════════════════════════════

  /**
   * Lấy danh sách quảng cáo từ market theo side (BUY/SELL).
   * Tự động lấy thêm trang tiếp theo nếu số lượng sau lọc < MIN_FILTERED,
   * cho đến khi đủ MIN_FILTERED hoặc đến trang cuối.
   * @param {string} side - 'BUY' hoặc 'SELL'
   * @param {number} startPage - Trang API bắt đầu của batch này (mặc định 1)
   * @param {boolean} pushHistory - Lưu startPage cũ vào history (để Prev hoạt động)
   */
  async function loadMarketAds(side, startPage = 1, pushHistory = false) {
    if (!state.secondaryConnected) return;

    const MIN_FILTERED = 10;
    const fiatUnit = document.getElementById('fiatFilter')?.value || state.fiatUnit;
    state.fiatUnit = fiatUnit;

    const tabKey = side === 'BUY' ? 'buy' : 'sell';
    const pageState = state[`${tabKey}Page`];

    setTableLoading(tabKey, true);

    try {
      // Lưu startPage hiện tại vào history nếu đang đi tới
      if (pushHistory) {
        pageState.history.push(pageState.startPage);
      }

      let accumulatedRaw = [];
      let currentPage = startPage;
      let totalPages = 1;

      // Loop lấy từng trang cho đến khi đủ MIN_FILTERED ads (sau lọc) hoặc hết trang
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

        // Áp dụng filter trên toàn bộ dữ liệu đã gom
        state[`${tabKey}AdsRaw`] = accumulatedRaw;
        applyMarketFilters(tabKey);

        // Đủ ads hoặc đã tới trang cuối thì dừng
        if (state[`${tabKey}Ads`].length >= MIN_FILTERED || currentPage >= totalPages) break;

        currentPage++;
      } while (true);

      // Cập nhật page state: giữ nguyên history, chỉ cập nhật các trường khác
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

  /**
   * Áp dụng bộ lọc client-side lên raw ads của một tab.
   * Lọc theo: online trong X phút, số lượng nằm trong giới hạn merchant.
   * @param {string} tabKey - 'buy' hoặc 'sell'
   */
  function applyMarketFilters(tabKey) {
    const raw = state[`${tabKey}AdsRaw`] || [];
    const { onlineMinutes, amount } = state.marketFilters;
    const now = Date.now();

    state[`${tabKey}Ads`] = raw.filter(ad => {
      const merchant = ad.merchant || {};

      // Điều kiện online: lastOnlineTime phải trong vòng X phút tính từ thời điểm hiện tại
      if (onlineMinutes > 0) {
        const lastOnline = merchant.lastOnlineTime;
        if (!lastOnline) return false;
        const diffMin = (now - lastOnline) / 60000;
        if (diffMin > onlineMinutes) return false;
      }

      // Điều kiện số lượng: amount phải nằm trong [minSingleTransAmount, maxSingleTransAmount]
      if (amount > 0) {
        const min = parseFloat(ad.minSingleTransAmount) || 0;
        const max = parseFloat(ad.maxSingleTransAmount) || Infinity;
        if (amount < min || amount > max) return false;
      }

      return true;
    });
  }

  /**
   * Đọc giá trị từ các input filter, cập nhật state.marketFilters,
   * áp dụng lại filter cho cả 2 tab, và cài đặt lại auto-refresh.
   */
  function updateMarketFilters() {
    const onlineMinutes = parseFloat(document.getElementById('filterOnlineMinutes').value) || 0;
    const amount = parseFloat(document.getElementById('filterAmount').value) || 0;
    const autoRefreshSec = parseInt(document.getElementById('filterAutoRefresh').value) || 0;

    state.marketFilters = { onlineMinutes, amount, autoRefreshSec };

    // Cập nhật label đơn vị số lượng theo fiat hiện tại
    const fiat = document.getElementById('fiatFilter')?.value || state.fiatUnit;
    const unitEl = document.getElementById('filterAmountUnit');
    if (unitEl) unitEl.textContent = fiat;

    // Áp dụng filter ngay lên data hiện có rồi render lại
    applyMarketFilters('buy');
    applyMarketFilters('sell');
    renderAdsTable('buy');
    renderAdsTable('sell');

    // Cài đặt auto-refresh
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

    // Hiển thị trạng thái filter đang áp dụng
    updateFilterStatus();

    showToast('Đã cập nhật thông số', 'success');
  }

  /**
   * Cập nhật dòng trạng thái hiển thị các filter đang hoạt động.
   */
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

  /**
   * Làm mới dữ liệu ads của tab đang hiển thị.
   * Reset history và tải lại từ trang 1.
   */
  async function refreshAds() {
    const side = state.currentTab === 'buy' ? 'BUY' : 'SELL';
    const tabKey = state.currentTab;
    // Reset history khi làm mới
    state[`${tabKey}Page`].history = [];
    await loadMarketAds(side, 1, false);
  }

  /**
   * Chuyển trang (trước/sau) trong danh sách ads.
   * Trang "sau" bắt đầu từ fetchedUpTo + 1.
   * Trang "trước" lấy startPage từ history stack.
   * @param {number} direction - +1 (trang sau) hoặc -1 (trang trước)
   */
  async function changePage(direction) {
    const tabKey = state.currentTab;
    const pageState = state[`${tabKey}Page`];
    const side = tabKey === 'buy' ? 'BUY' : 'SELL';

    if (direction > 0) {
      // Trang sau: bắt đầu từ trang API tiếp theo chưa fetch
      if (pageState.fetchedUpTo >= pageState.total) return;
      await loadMarketAds(side, pageState.fetchedUpTo + 1, true);
    } else {
      // Trang trước: lấy startPage cũ từ history
      if (pageState.history.length === 0) return;
      const prevStart = pageState.history.pop();
      await loadMarketAds(side, prevStart, false);
    }
  }

  // ─── Render giao diện Market Ads ─────────────────────

  /**
   * Render bảng danh sách ads (BUY hoặc SELL) vào HTML.
   * @param {string} tabKey - 'buy' hoặc 'sell'
   */
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

  /**
   * Cập nhật UI phân trang.
   * Hiển thị range trang API đã fetch (ví dụ "Trang 1–3 / 15")
   * và số lượng ads sau lọc.
   * @param {string} tabKey - 'buy' hoặc 'sell'
   * @param {Object} pageInfo - { startPage, fetchedUpTo, total, history }
   */
  function updatePagination(tabKey, pageInfo) {
    const el = document.getElementById(`${tabKey}Pagination`);
    if (!el) return;

    const hasPrev = pageInfo.history && pageInfo.history.length > 0;
    const hasNext = pageInfo.fetchedUpTo < pageInfo.total;
    const filteredCount = state[`${tabKey}Ads`].length;

    // Hiển thị "Trang X–Y / Z" nếu fetch nhiều hơn 1 trang, ngược lại "Trang X / Z"
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

  /**
   * Chuyển đổi tab BUY / SELL.
   * @param {string} tab - 'buy' hoặc 'sell'
   */
  function switchTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === `${tab}Panel`);
    });
  }

  /**
   * Cập nhật giao diện khi trạng thái kết nối thay đổi.
   * @param {boolean} connected - Trạng thái kết nối
   * @param {string} host - Tên host đang kết nối
   */
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

  /**
   * Hiển thị toast thông báo ở góc trên phải màn hình.
   * Tự động biến mất sau 3.5 giây.
   * @param {string} message - Nội dung thông báo
   * @param {string} type - Loại: 'success', 'error', hoặc 'info'
   */
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

  /** Bật/tắt loading cho button */
  function setLoading(loading, btnId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
  }

  /** Bật/tắt loading overlay cho bảng market ads */
  function setTableLoading(tabKey, loading) {
    const panel = document.getElementById(`${tabKey}Panel`);
    if (!panel) return;
    panel.classList.toggle('table-loading', loading);
  }

  /**
   * Format số theo kiểu Việt Nam (dấu chấm phân cách hàng nghìn).
   * @param {number|string} num - Số cần format
   * @returns {string} Chuỗi đã format
   */
  function formatNumber(num) {
    if (!num && num !== 0) return '—';
    const n = parseFloat(num);
    if (isNaN(n)) return num;
    return n.toLocaleString('vi-VN', { maximumFractionDigits: 4 });
  }

  /**
   * Format timestamp (milliseconds) thành chuỗi ngày giờ.
   * @param {number} ts - Timestamp dạng milliseconds
   * @returns {string} Chuỗi "DD/MM/YY HH:mm"
   */
  function formatDate(ts) {
    const d = new Date(ts);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(2);
    const hour = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hour}:${min}`;
  }

  /**
   * Rút gọn mã ID dài (advNo) để hiển thị gọn trong bảng.
   * Ví dụ: "a1375750128856004608" → "a137...4608"
   * @param {string} id - Mã cần rút gọn
   * @returns {string} Mã đã rút gọn
   */
  function truncateId(id) {
    if (!id || id.length <= 12) return id;
    return id.slice(0, 4) + '...' + id.slice(-4);
  }

  /** Escape HTML để tránh XSS */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Chuyển mã payment method thành tên hiển thị.
   * @param {string} methodStr - Chuỗi mã (có thể nhiều mã phân tách bởi dấu phẩy)
   * @returns {string} Tên phương thức thanh toán
   */
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

  /** Xem chi tiết quảng cáo (placeholder) */
  function viewAd(advNo) {
    showToast(`Chi tiết quảng cáo: ${advNo}`, 'info');
  }

  /** Toggle hiện/ẩn Secret Key input */
  function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
  }

  // ─── Khởi tạo ────────────────────────────────────────

  /**
   * Hàm khởi tạo chạy khi DOM loaded.
   * Kiểm tra trạng thái kết nối, tải config, auto-load data nếu đã kết nối.
   */
  async function init() {
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
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
