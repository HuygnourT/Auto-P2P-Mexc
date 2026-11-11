# MEXC P2P Automated Trading System

## Cấu trúc dự án

```
mexc-p2p/
├── src/                        # Backend (Node.js / Express)
│   ├── config/
│   │   └── index.js            # Cấu hình: port, API host, fiat mặc định, rate limit
│   ├── services/
│   │   └── mexcP2P.js          # Service gọi MEXC P2P API (market ads, my ads, tạo ads)
│   ├── routes/
│   │   └── api.js              # REST endpoints: connect, disconnect, market/ads, my/ads
│   ├── middleware/
│   │   └── rateLimiter.js      # Giới hạn 10 request/giây theo tài liệu MEXC
│   ├── utils/
│   │   ├── crypto.js           # Tạo chữ ký HMAC-SHA256 cho API request
│   │   └── logger.js           # Ghi log với 4 mức: DEBUG, INFO, WARN, ERROR
│   └── server.js               # Entry point: khởi động Express server
├── public/                     # Frontend (HTML / CSS / JS)
│   ├── css/
│   │   └── style.css           # Dark trading terminal theme
│   ├── js/
│   │   └── app.js              # Logic giao diện: kết nối, hiển thị ads, phân trang
│   └── index.html              # Trang chính
├── .env.example                # Mẫu biến môi trường
└── package.json
```

## Cài đặt & Chạy

```bash
npm install
npm start
```

Mở trình duyệt: http://localhost:3000

## Tính năng

- Nhập API Key & Secret Key qua giao diện
- Chọn API host: api.mexc.com hoặc api.mexc.co
- Xem quảng cáo BUY/SELL trên market P2P (mặc định VND)
- Lọc theo fiat currency, phân trang
- Rate limiting 10 req/s

## Mở rộng

- `src/services/` — Thêm service mới (order, chat, ...)
- `src/routes/` — Thêm route groups mới
- `src/middleware/` — Thêm authentication, validation, ...

---

## Engine tự chỉnh giá trên server + Telegram Bot

Từ bản này, **engine tự chỉnh giá chạy trong app Node** (máy chạy `npm start`), không còn chạy trong trình duyệt.
Web dashboard và Telegram Bot chỉ là 2 nơi điều khiển **cùng 1 engine, cùng 1 cấu hình**.

- Bật auto-pricer một lần là chạy liên tục, **không cần mở tab web**.
- Cấu hình **tự lưu** vào `data/settings.json` ngay khi thay đổi (giữ định dạng cũ: `mexcPricer`, `bitgetPricer`, `bybitPricer`, `bingxPricer`).
- Thay đổi từ Telegram hiện ngay trên web (SSE), và ngược lại.
- Mỗi sàn đúng 1 worker; khóa theo sàn khi gửi cập nhật → engine, web, Telegram không ghi đè nhau.
- Mọi thay đổi + kết quả từ sàn ghi vào `data/audit.log` (không ghi key/token).
- Khởi động lại app: cần **kết nối lại các sàn** trên web và bấm **Bật** auto-pricer (kết nối sàn chỉ giữ trong bộ nhớ, như trước). Telegram Bot tự chạy lại nếu đã bật.

### Cài đặt Telegram Bot

1. Telegram → chat **@BotFather** → `/newbot` → nhận **Bot Token**.
2. Chat **@userinfobot** → lấy **User ID**. Chat riêng với bot: **Chat ID = User ID**.
3. Dashboard → tab **Telegram** → nhập Token, User ID, Chat ID → bật **Bật bot** → **Lưu & áp dụng** → **Kiểm tra kết nối**.
4. Mở bot, gõ `/menu`.

Bot dùng long polling (không cần domain/mở port). Chỉ User ID + Chat ID đã cấu hình được dùng bot.
Token lưu trong `data/settings.json` trên máy bạn, không bao giờ trả về trình duyệt.

### Tham số quảng cáo (Telegram)

| Tham số | Ý nghĩa | Áp dụng |
|---|---|---|
| Số lượng QC | Số lượng coin của quảng cáo (BingX: tổng `totalNumber`) | Gửi lên sàn ngay |
| Trần giá / Sàn giá | Giá không vượt / không thấp hơn | Cấu hình engine + tính lại giá ngay |
| SL GD (Số lượng GD) | Số tiền VND dùng để lọc ads đối thủ theo Min–Max của họ | Cấu hình engine + tính lại giá ngay |
| Min / Max | Giới hạn giao dịch mỗi lệnh | Gửi lên sàn, sàn xác nhận mới lưu |

Trần/Sàn: ô `priceLimit` cũ giữ nguyên (Trần cho ad MUA, Sàn cho ad BÁN); thêm cột cận còn lại (`priceFloor` cho MUA, `priceCeiling` cho BÁN).

### Bảng tương thích API

| Chức năng | MEXC | Bitget | Bybit | BingX |
|---|---|---|---|---|
| Ads của tôi | ✅ (API chính) | ✅ | ✅ | ✅ |
| Market công khai | ✅ (cần API phụ) | ✅ | ✅ | ✅ (không cần ký) |
| Sửa giá | ✅ save_or_update | ✅ ad-update | ✅ item/update | ✅ advert/modify |
| Sửa số lượng | ✅ initQuantity | ✅ quantity | ✅ quantity | ✅ totalNumber (tổng) |
| Sửa Min/Max | ✅ | ✅ | ✅ | ✅ |
| Online/Offline | ✅ advStatus | ✅ publish/delist | ✅ status 10 | ✅ status 0/1 |

### API mới (backend)

- `GET /api/events` — SSE realtime
- `GET /api/engine/state`, `GET /api/engine/:ex/state`, `GET /api/engine/caps`
- `POST /api/engine/:ex/start|stop|settings|refresh`
- `POST /api/engine/:ex/ads/:key` — sửa cấu hình ad/dòng (`{ patch, expectV }`)
- `POST /api/engine/:ex/rows`, `POST /api/engine/:ex/rows/:key/delete`
- `POST /api/engine/:ex/ad/:adId/param` — đổi tham số qua quy trình đầy đủ (như Telegram)
- `GET /api/engine/:ex/raw-ads`, `GET /api/market/best`, `GET /api/market/list`, `GET /api/audit`
- `GET /api/telegram/status`, `POST /api/telegram/config`, `POST /api/telegram/test`

### Telegram — cập nhật: lọc giá tốt nhất, bật/tắt Auto Pricing, lọc quảng cáo

- **🏆 Giá tốt nhất → chọn sàn**: đặt **SL khả dụng tối thiểu** riêng cho từng sàn (Tất cả / ≥100 / ≥500 / ≥1,000 / ≥5,000 / Tuỳ chỉnh), xem giá MUA / BÁN / cả hai kèm thông tin quảng cáo. Lưu trong `settings.marketFilters`, dùng chung với ô "SL khả dụng ≥" ở thẻ Market trên web. Không ảnh hưởng bộ lọc đối thủ của auto-pricer.
- **⏯ Điều khiển Auto Pricing**: xem trạng thái 4 sàn; bật/tắt từng sàn, **Bật tất cả / Tắt tất cả** (luôn hỏi xác nhận, báo kết quả thật từng sàn); bật/tắt **Auto Repricing** cho từng quảng cáo. Tắt chỉ dừng engine — giữ cấu hình, không xóa quảng cáo, không đổi Online/Offline.
- **📋 Quảng cáo của tôi → 🔎 Bộ lọc**: kết hợp Trạng thái (Online/Offline) × Loại (MUA/BÁN) × Auto Repricing (Bật/Tắt). Chưa chọn = Tất cả; giữ bộ lọc khi chuyển trang / làm mới; mở lại từ menu chọn sàn thì về mặc định.

4 trạng thái khác nhau: **Kết nối API** (sàn) · **Online/Offline** (quảng cáo trên sàn) · **Auto Pricing Running/Stopped** (engine của sàn) · **Auto Repricing Bật/Tắt** (từng quảng cáo).

API mới: `GET /api/market/filters`, `POST /api/market/filters/:ex` (`{ minQty }`).

### Giá tốt nhất — bộ lọc Limit Min (VND)
- Telegram → 🏆 Giá tốt nhất → chọn sàn → ✏️ Sửa Limit Min: Tất cả · 100,000 · 500,000 · 1,000,000 · 5,000,000 · Tuỳ chỉnh (gõ `2,000,000`, `1.500.000`, `2tr`, `500k`).
- Điều kiện: chỉ giữ quảng cáo có **Limit Min ≤ số tiền đã chọn ≤ Limit Max** (giao dịch được với số tiền đó). Áp dụng cho cả Best BUY và Best SELL, lưu riêng từng sàn trong `data/settings.json` → `bestPriceFilters`.
- Không thay đổi Min/Max quảng cáo trên sàn, không ảnh hưởng auto-pricer. Bộ lọc SL khả dụng (USDT) chỉ còn dùng cho Market P2P.
- API: `GET /api/market/best-filters`, `POST /api/market/best-filters/:ex {limitMin}`, `GET /api/market/best?limitMin=saved|<số>`.
