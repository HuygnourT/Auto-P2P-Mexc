# MEXC P2P Tool

Tool tự động theo dõi thị trường P2P MEXC với giao diện web chuyên nghiệp.

## Cấu trúc thư mục

```
mexc-p2p-tool/
├── server/
│   ├── config/
│   │   └── api.config.js       # Cấu hình API endpoints, defaults
│   ├── middleware/
│   │   └── rateLimit.middleware.js  # Rate limiting (10 req/s)
│   ├── routes/
│   │   └── p2p.routes.js       # API routes cho P2P
│   ├── services/
│   │   ├── p2p.service.js      # Logic gọi MEXC API
│   │   └── signature.service.js # Tạo chữ ký HMAC SHA256
│   └── index.js                # Entry point, Express server
├── public/
│   ├── css/
│   │   └── style.css           # Stylesheet (dark theme)
│   ├── js/
│   │   └── app.js              # Frontend JavaScript
│   └── index.html              # Giao diện chính
├── .env.example                # Mẫu biến môi trường
├── package.json
└── README.md
```

## Cài đặt

```bash
# Clone / giải nén project
cd mexc-p2p-tool

# Cài đặt dependencies
npm install

# Copy file env
cp .env.example .env
# (tùy chọn) điền API key vào .env nếu muốn dùng server-side keys

# Chạy server
npm start

# Hoặc dev mode (auto-reload)
npm run dev
```

Truy cập: http://localhost:3000

## Chức năng

- **Chọn Gateway**: mexc.com hoặc mexc.co
- **API Key Authentication**: Nhập API Key & Secret Key trực tiếp trên giao diện
- **Xem ads Buy/Sell**: Hiển thị cả 2 chiều hoặc từng chiều
- **Bộ lọc mạnh mẽ**:
  - Cặp tiền tệ Fiat (VND mặc định, USD, EUR, hoặc tùy chỉnh)
  - Coin (USDT, BTC, ETH, hoặc tùy chỉnh)
  - Loại lệnh (Mua/Bán/Tất cả)
  - Số tiền Fiat (Amount)
  - Số lượng Coin (Quantity)
  - Phân trang
- **Tự động làm mới**: 10s, 30s, 60s
- **Thống kê nhanh**: Số lượng ads, giá tốt nhất Buy/Sell

## API Endpoints (Backend)

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/api/p2p/ads` | Lấy ads (cả 2 chiều hoặc 1 chiều) |
| GET | `/api/p2p/ads/buy` | Lấy ads Buy |
| GET | `/api/p2p/ads/sell` | Lấy ads Sell |
| GET | `/api/p2p/gateways` | Danh sách gateways |
| GET | `/api/health` | Health check |

### Headers bắt buộc
```
x-api-key: YOUR_MEXC_API_KEY
x-secret-key: YOUR_MEXC_SECRET_KEY
```

### Query Parameters (GET /api/p2p/ads)
| Param | Type | Default | Mô tả |
|-------|------|---------|-------|
| gateway | string | mexc.com | mexc.com hoặc mexc.co |
| fiatUnit | string | VND | Mã tiền tệ fiat |
| coinId | string | USDT | Mã coin |
| side | string | (cả 2) | BUY hoặc SELL |
| page | integer | 1 | Số trang |
| amount | BigDecimal | - | Lọc theo số tiền fiat |
| quantity | BigDecimal | - | Lọc theo số lượng coin |

## Lưu ý

- API yêu cầu đăng nhập: https://www.mexc.com/user/openapi
- Tối đa 10 requests/giây
- `code=0` trong response = thành công
- Signature được tạo tự động theo chuẩn HMAC SHA256
