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
    connected: false,          // Đã kết nối API chưa
    currentTab: 'buy',         // Tab đang chọn: 'buy' hoặc 'sell'
    loading: false,            // Đang tải dữ liệu
    buyAds: [],                // Danh sách ads BUY từ market
    sellAds: [],               // Danh sách ads SELL từ market
    buyPage: { current: 1, total: 1 },   // Phân trang tab BUY
    sellPage: { current: 1, total: 1 },  // Phân trang tab SELL
    fiatUnit: 'VND',           // Loại tiền fiat đang lọc
  };

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
   * Nếu thành công, tự động load ads BUY và SELL.
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
        // Tự động tải danh sách ads sau khi kết nối
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
   * Gọi POST /api/disconnect, xóa dữ liệu ads, cập nhật giao diện.
   */
  async function disconnect() {
    await api.post('/api/disconnect');
    state.connected = false;
    state.buyAds = [];
    state.sellAds = [];
    updateConnectionUI(false);
    renderAdsTable('buy');
    renderAdsTable('sell');
    showToast('Đã ngắt kết nối', 'info');
  }

  // ─── Lấy dữ liệu Market Ads ─────────────────────────

  /**
   * Lấy danh sách quảng cáo từ market theo side (BUY/SELL).
   * Gọi GET /api/market/ads với fiatUnit và page.
   * Lưu kết quả vào state rồi render bảng HTML.
   * @param {string} side - 'BUY' hoặc 'SELL'
   * @param {number} page - Số trang (mặc định 1)
   */
  async function loadMarketAds(side, page = 1) {
    if (!state.connected) return;

    const fiatUnit = document.getElementById('fiatFilter')?.value || state.fiatUnit;
    state.fiatUnit = fiatUnit;

    const tabKey = side === 'BUY' ? 'buy' : 'sell';
    setTableLoading(tabKey, true);

    try {
      const result = await api.get(
        `/api/market/ads?side=${side}&fiatUnit=${fiatUnit}&page=${page}&coinId=USDT`
      );

      // Log kết quả trả về từ API ra console (F12 → Console để xem)
      console.log(`[${side}] API response:`, result);

      if (result.code === 0) {
        state[`${tabKey}Ads`] = result.data || [];
        state[`${tabKey}Page`] = {
          current: result.page?.currPage || 1,
          total: result.page?.totalPage || 1,
        };
      } else {
        showToast(`Lỗi lấy dữ liệu ${side}: ${result.msg}`, 'error');
      }
    } catch (err) {
      showToast(`Lỗi: ${err.message}`, 'error');
    } finally {
      setTableLoading(tabKey, false);
      renderAdsTable(tabKey);
    }
  }

  /**
   * Làm mới dữ liệu ads của tab đang hiển thị.
   * Gọi lại loadMarketAds với side tương ứng, quay về trang 1.
   */
  async function refreshAds() {
    const side = state.currentTab === 'buy' ? 'BUY' : 'SELL';
    await loadMarketAds(side, 1);
  }

  /**
   * Chuyển trang (trước/sau) trong danh sách ads.
   * @param {number} direction - +1 (trang sau) hoặc -1 (trang trước)
   */
  async function changePage(direction) {
    const tabKey = state.currentTab;
    const pageState = state[`${tabKey}Page`];
    const newPage = pageState.current + direction;

    if (newPage < 1 || newPage > pageState.total) return;

    const side = tabKey === 'buy' ? 'BUY' : 'SELL';
    await loadMarketAds(side, newPage);
  }

  // ─── Render giao diện ────────────────────────────────

  /**
   * Render bảng danh sách ads (BUY hoặc SELL) vào HTML.
   * Nếu không có ads, hiển thị empty state.
   * Mỗi row hiển thị: tên merchant, giá, số lượng, giới hạn, phương thức thanh toán.
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

    // Render từng row ads với thông tin merchant, giá, số lượng, ...
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
   * Cập nhật UI phân trang: nút Trước, Sau, và thông tin trang hiện tại.
   * @param {string} tabKey - 'buy' hoặc 'sell'
   * @param {Object} pageInfo - { current, total }
   */
  function updatePagination(tabKey, pageInfo) {
    const el = document.getElementById(`${tabKey}Pagination`);
    if (!el) return;

    el.innerHTML = `
      <button class="btn-page" onclick="App.changePage(-1)" ${pageInfo.current <= 1 ? 'disabled' : ''}>
        ‹ Trước
      </button>
      <span class="page-info">Trang ${pageInfo.current} / ${pageInfo.total}</span>
      <button class="btn-page" onclick="App.changePage(1)" ${pageInfo.current >= pageInfo.total ? 'disabled' : ''}>
        Sau ›
      </button>
    `;
  }

  /**
   * Chuyển đổi tab BUY / SELL.
   * Cập nhật class active cho button tab và panel tương ứng.
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
   * Connected: hiện nút Ngắt kết nối, khóa input, đổi status dot sang xanh.
   * Disconnected: hiện nút Kết nối, mở khóa input, status dot xám.
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

  /**
   * Bật/tắt trạng thái loading cho button (disabled + spinner animation).
   * @param {boolean} loading - true = đang tải, false = xong
   * @param {string} btnId - ID của button element
   */
  function setLoading(loading, btnId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
  }

  /**
   * Bật/tắt overlay loading cho bảng ads (mờ bảng + text "Đang tải...").
   * @param {string} tabKey - 'buy' hoặc 'sell'
   * @param {boolean} loading - true = đang tải
   */
  function setTableLoading(tabKey, loading) {
    const panel = document.getElementById(`${tabKey}Panel`);
    if (!panel) return;
    panel.classList.toggle('table-loading', loading);
  }

  /**
   * Format số thành chuỗi có dấu phân cách hàng nghìn (kiểu Việt Nam).
   * Ví dụ: 25000 → "25.000", 1.2345 → "1,2345"
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
   * Escape HTML để tránh XSS khi hiển thị dữ liệu từ API.
   * Chuyển ký tự đặc biệt (<, >, &, ", ') thành HTML entities.
   * @param {string} str - Chuỗi cần escape
   * @returns {string} Chuỗi an toàn cho innerHTML
   */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Chuyển mã phương thức thanh toán (số) thành tên hiển thị.
   * Ví dụ: "1" → "Ngân hàng", "2" → "Momo"
   * Nếu không nhận diện được, hiển thị "PM-{mã}".
   * @param {string} methodStr - Chuỗi mã payment (có thể chứa nhiều mã phân tách bởi dấu phẩy)
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

  /**
   * Xem chi tiết quảng cáo (placeholder cho chức năng tương lai).
   * Hiện tại chỉ hiện toast với mã advNo.
   * @param {string} advNo - Mã quảng cáo
   */
  function viewAd(advNo) {
    showToast(`Chi tiết quảng cáo: ${advNo}`, 'info');
  }

  /**
   * Toggle hiển thị/ẩn Secret Key input (password ↔ text).
   * @param {string} inputId - ID của input element
   */
  function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
  }

  // ─── Khởi tạo ────────────────────────────────────────

  /**
   * Hàm khởi tạo chạy khi DOM loaded.
   * 1. Kiểm tra trạng thái kết nối từ backend (nếu đã kết nối trước đó).
   * 2. Tải cấu hình (danh sách API host) từ backend để render dropdown.
   * 3. Nếu đã kết nối, tự động load ads BUY và SELL.
   */
  async function init() {
    // Kiểm tra trạng thái kết nối hiện tại
    const status = await api.get('/api/status');
    if (status.data?.connected) {
      state.connected = true;
      updateConnectionUI(true, '');
      await loadMarketAds('BUY');
      await loadMarketAds('SELL');
    }

    // Tải danh sách API host từ backend config
    const config = await api.get('/api/config');
    if (config.data?.apiHosts) {
      const select = document.getElementById('apiHost');
      select.innerHTML = config.data.apiHosts
        .map(h => `<option value="${h.value}">${h.label}</option>`)
        .join('');
    }
  }

  // ─── Public API: Các hàm được gọi từ HTML onclick ────
  return {
    init,                        // Khởi tạo ứng dụng
    connect,                     // Kết nối API
    disconnect,                  // Ngắt kết nối
    switchTab,                   // Chuyển tab BUY/SELL
    refreshAds,                  // Làm mới dữ liệu ads
    changePage,                  // Chuyển trang
    loadMarketAds,               // Tải ads từ market
    viewAd,                      // Xem chi tiết ads
    togglePasswordVisibility,    // Hiện/ẩn Secret Key
  };
})();

// Chạy init() khi trang web load xong
document.addEventListener('DOMContentLoaded', App.init);
