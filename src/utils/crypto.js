const crypto = require('crypto');

/**
 * Tạo chữ ký HMAC-SHA256 cho request gửi đến MEXC API.
 * Đây là bước bắt buộc theo tài liệu API để xác thực mỗi request.
 * @param {string} queryString - Chuỗi query cần ký (vd: "timestamp=123&fiatUnit=VND")
 * @param {string} secretKey - Secret Key từ tài khoản MEXC
 * @returns {string} Chuỗi chữ ký dạng hex
 */
function generateSignature(queryString, secretKey) {
  return crypto
    .createHmac('sha256', secretKey)
    .update(queryString)
    .digest('hex');
}

/**
 * Xây dựng chuỗi query đã ký (signed query string).
 * Tự động thêm timestamp hiện tại, sắp xếp tham số theo alphabet,
 * loại bỏ tham số rỗng, rồi tạo chữ ký và gắn vào cuối query.
 * @param {Object} params - Các tham số request (vd: { fiatUnit: 'VND', page: 1 })
 * @param {string} secretKey - Secret Key từ tài khoản MEXC
 * @returns {string} Chuỗi query hoàn chỉnh có signature (vd: "fiatUnit=VND&timestamp=...&signature=...")
 */
function buildSignedQuery(params, secretKey) {
  const timestamp = Date.now();
  const queryParams = { ...params, timestamp };

  // Sắp xếp tham số theo thứ tự alphabet rồi ghép thành query string
  const queryString = Object.keys(queryParams)
    .sort()
    .filter(key => queryParams[key] !== undefined && queryParams[key] !== '')
    .map(key => `${key}=${encodeURIComponent(queryParams[key])}`)
    .join('&');

  // Tạo chữ ký và gắn vào cuối
  const signature = generateSignature(queryString, secretKey);
  return `${queryString}&signature=${signature}`;
}

module.exports = { generateSignature, buildSignedQuery };
