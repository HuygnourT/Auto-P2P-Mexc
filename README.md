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
