// public/js/app.js
'use strict';

// ─── State ──────────────────────────────────────────────
const state = {
  gateway: 'mexc.com',
  fiatUnit: 'VND',
  coinId: 'USDT',
  side: '',
  page: 1,
  autoRefreshSecs: 0,
  autoRefreshTimer: null,
  lastData: null,
  loading: false
};

// ─── Utils ──────────────────────────────────────────────
function fmt(n, decimals = 2) {
  if (n == null || n === '') return '—';
  return parseFloat(n).toLocaleString('vi-VN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function fmtCoin(n) {
  if (n == null) return '—';
  const v = parseFloat(n);
  if (v >= 1000) return fmt(v, 2);
  if (v >= 1)    return fmt(v, 4);
  return fmt(v, 6);
}

function timeStr() {
  return new Date().toLocaleTimeString('vi-VN');
}

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function setStatus(status, text) {
  const badge = document.getElementById('statusBadge');
  const label = document.getElementById('statusText');
  badge.className = `status-badge ${status}`;
  label.textContent = text;
}

// ─── Toggle Groups ───────────────────────────────────────
function initToggleGroup(groupId, onChange) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(btn.dataset.value);
    });
  });
}

initToggleGroup('gatewayToggle', v => { state.gateway = v; });

initToggleGroup('fiatToggle', v => {
  const customInput = document.getElementById('customFiat');
  if (v === 'custom') {
    customInput.style.display = 'block';
    customInput.focus();
    state.fiatUnit = customInput.value || 'VND';
  } else {
    customInput.style.display = 'none';
    state.fiatUnit = v;
  }
});

document.getElementById('customFiat').addEventListener('input', e => {
  state.fiatUnit = e.target.value.toUpperCase() || 'VND';
});

initToggleGroup('coinToggle', v => {
  const customInput = document.getElementById('customCoin');
  if (v === 'custom') {
    customInput.style.display = 'block';
    customInput.focus();
    state.coinId = customInput.value || 'USDT';
  } else {
    customInput.style.display = 'none';
    state.coinId = v;
  }
});

document.getElementById('customCoin').addEventListener('input', e => {
  state.coinId = e.target.value.toUpperCase() || 'USDT';
});

initToggleGroup('sideToggle', v => { state.side = v; });

initToggleGroup('autoRefreshToggle', v => {
  const secs = parseInt(v) || 0;
  state.autoRefreshSecs = secs;
  clearInterval(state.autoRefreshTimer);
  if (secs > 0) {
    state.autoRefreshTimer = setInterval(() => fetchData(), secs * 1000);
    showToast(`Tự động làm mới mỗi ${secs}s`, 'info');
  }
});

// ─── Pagination ──────────────────────────────────────────
function updatePageDisplay() {
  document.getElementById('currentPageDisplay').textContent = state.page;
}

document.getElementById('prevPage').addEventListener('click', () => {
  if (state.page > 1) { state.page--; updatePageDisplay(); }
});

document.getElementById('nextPage').addEventListener('click', () => {
  state.page++;
  updatePageDisplay();
});

// ─── API Call ────────────────────────────────────────────
async function fetchData() {
  if (state.loading) return;
  state.loading = true;

  document.getElementById('loadingOverlay').style.display = 'flex';
  document.getElementById('fetchBtn').disabled = true;
  setStatus('', 'Đang tải...');

  try {
    const params = new URLSearchParams({
      gateway:  state.gateway,
      fiatUnit: state.fiatUnit,
      coinId:   state.coinId,
      page:     state.page
    });

    if (state.side) params.set('side', state.side);

    const amountVal   = document.getElementById('amountFilter').value;
    const quantityVal = document.getElementById('quantityFilter').value;
    if (amountVal)   params.set('amount', amountVal);
    if (quantityVal) params.set('quantity', quantityVal);

    const response = await fetch(`/api/p2p/ads?${params.toString()}`);
    const json = await response.json();

    if (!json.success) throw new Error(json.error || 'Lỗi không xác định');

    state.lastData = json;
    renderResults(json);
    setStatus('online', 'Đã kết nối');
    showToast('Tải dữ liệu thành công!', 'success');

  } catch (err) {
    setStatus('error', 'Lỗi kết nối');
    showToast(`Lỗi: ${err.message}`, 'error');
    renderError(err.message);
    console.error(err);
  } finally {
    state.loading = false;
    document.getElementById('loadingOverlay').style.display = 'none';
    document.getElementById('fetchBtn').disabled = false;
  }
}

// ─── Render ──────────────────────────────────────────────
function renderResults(json) {
  const area     = document.getElementById('resultsArea');
  const statsBar = document.getElementById('statsBar');
  statsBar.style.display = 'flex';

  const isBothSides = json.data?.buy !== undefined && json.data?.sell !== undefined;

  if (isBothSides) {
    const buyList  = extractAds(json.data.buy);
    const sellList = extractAds(json.data.sell);

    document.getElementById('statBuy').textContent      = buyList.length;
    document.getElementById('statSell').textContent     = sellList.length;
    document.getElementById('statBestBuy').textContent  = buyList.length  ? fmt(buyList[0].price)  : '—';
    document.getElementById('statBestSell').textContent = sellList.length ? fmt(sellList[0].price) : '—';
    document.getElementById('statTime').textContent     = timeStr();

    area.innerHTML = `
      <div class="tabs-header">
        <button class="tab-btn active buy"  data-tab="buy"  onclick="switchTab('buy')">
          MUA <span class="tab-count">${buyList.length}</span>
        </button>
        <button class="tab-btn sell" data-tab="sell" onclick="switchTab('sell')">
          BÁN <span class="tab-count">${sellList.length}</span>
        </button>
      </div>
      <div id="tab-buy"  class="ads-content fade-in">${renderTable(buyList,  'BUY',  json.filters?.fiatUnit, json.filters?.coinId)}</div>
      <div id="tab-sell" class="ads-content fade-in" style="display:none">${renderTable(sellList, 'SELL', json.filters?.fiatUnit, json.filters?.coinId)}</div>
    `;
  } else {
    const ads  = extractAds(json.data);
    const side = json.data?.side || '';

    document.getElementById('statBuy').textContent      = side === 'BUY'  ? ads.length : '—';
    document.getElementById('statSell').textContent     = side === 'SELL' ? ads.length : '—';
    document.getElementById('statBestBuy').textContent  = (side === 'BUY'  && ads.length) ? fmt(ads[0].price) : '—';
    document.getElementById('statBestSell').textContent = (side === 'SELL' && ads.length) ? fmt(ads[0].price) : '—';
    document.getElementById('statTime').textContent     = timeStr();

    area.innerHTML = `
      <div class="ads-content fade-in">
        ${renderTable(ads, side, json.filters?.fiatUnit, json.filters?.coinId)}
      </div>
    `;
  }
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('tab-buy').style.display  = tab === 'buy'  ? 'block' : 'none';
  document.getElementById('tab-sell').style.display = tab === 'sell' ? 'block' : 'none';
}
window.switchTab = switchTab;

function extractAds(data) {
  if (!data || data.error) return [];
  return data.data?.list || data.data || data.list || data.rows || [];
}

function renderTable(ads, side, fiatUnit = 'VND', coinId = 'USDT') {
  if (!ads || ads.length === 0) {
    return `<div class="empty-state"><div class="empty-icon">○</div><p>Không có dữ liệu ${side} ads</p></div>`;
  }

  const rows = ads.map((ad, i) => {
    const price        = ad.price || ad.adPrice || ad.tradePrice || '—';
    const available    = ad.surplusAmount || ad.availableAmount || ad.quantity || '—';
    const minAmt       = ad.minTradeAmount || ad.minAmount || '—';
    const maxAmt       = ad.maxTradeAmount || ad.maxAmount || '—';
    const merchantName = ad.nickName || ad.merchantName || ad.username || 'Ẩn danh';
    const completedOrders = ad.finishRate != null
      ? `${(ad.finishRate * 100).toFixed(1)}%`
      : (ad.completedOrderNum != null ? `${ad.completedOrderNum} lệnh` : '—');
    const payMethods = Array.isArray(ad.payMethodList)
      ? ad.payMethodList.map(p => `<span class="pay-tag">${p.payMethodName || p.name || p}</span>`).join('')
      : '—';

    const sideClass = (ad.tradeType === 'BUY' || side === 'BUY') ? 'buy' : 'sell';

    return `
      <tr>
        <td>${i + 1}</td>
        <td>
          <div class="merchant-cell">
            <span class="merchant-name">${merchantName}</span>
            <span class="merchant-orders">${completedOrders}</span>
          </div>
        </td>
        <td><span class="price-cell ${sideClass}">${fmt(price)}</span> <span style="color:var(--text-dim);font-size:10px">${fiatUnit}</span></td>
        <td>
          <div class="limit-bar">
            <span class="limit-avail">${fmtCoin(available)} ${coinId}</span>
            <span class="limit-text">Giới hạn: ${fmt(minAmt, 0)} – ${fmt(maxAmt, 0)} ${fiatUnit}</span>
          </div>
        </td>
        <td><div class="payment-tags">${payMethods}</div></td>
        <td><span class="badge badge-${sideClass}">${ad.tradeType || side}</span></td>
      </tr>
    `;
  }).join('');

  return `
    <div class="table-wrapper">
      <table class="ads-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Người đăng</th>
            <th>Giá (${fiatUnit})</th>
            <th>Khả dụng / Giới hạn</th>
            <th>Phương thức</th>
            <th>Loại</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderError(msg) {
  document.getElementById('resultsArea').innerHTML = `
    <div class="error-msg">
      <strong>⚠ Lỗi tải dữ liệu</strong>
      ${msg}
    </div>
  `;
}

// ─── Events ──────────────────────────────────────────────
document.getElementById('fetchBtn').addEventListener('click', () => {
  state.page = 1;
  updatePageDisplay();
  fetchData();
});

document.getElementById('refreshBtn').addEventListener('click', fetchData);

['amountFilter', 'quantityFilter'].forEach(id => {
  document.getElementById(id)?.addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchData();
  });
});

// ─── Init ────────────────────────────────────────────────
updatePageDisplay();
console.log('%c MEXC P2P Tool v1.1.0 ', 'background:#f0c040;color:#000;font-weight:bold;padding:4px 12px;border-radius:3px;');
