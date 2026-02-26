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
 * Tự động thêm timestamp, loại bỏ tham số rỗng,
 * ghép thành query string RAW (không encode) rồi ký bằng HMAC-SHA256.
 *
 * Logic khớp với Java demo của MEXC:
 *   1. Ghép params thành chuỗi dạng "key=value&key=value" (giá trị RAW, không encode)
 *   2. Ký chuỗi RAW đó bằng HMAC-SHA256
 *   3. Gắn signature vào cuối query string
 *
 * @param {Object} params - Các tham số request (vd: { fiatUnit: 'VND', page: 1 })
 * @param {string} secretKey - Secret Key từ tài khoản MEXC
 * @returns {string} Chuỗi query hoàn chỉnh có signature
 */
function buildSignedQuery(params, secretKey) {
  const timestamp = Date.now();
  const queryParams = { ...params, timestamp };

  // Ghép params thành query string RAW (không encode), giống Java demo:
  //   String queryString = "timestamp=" + timestamp;
  const queryString = Object.keys(queryParams)
    .filter(key => queryParams[key] !== undefined && queryParams[key] !== '')
    .map(key => `${key}=${queryParams[key]}`)
    .join('&');

  // Ký chuỗi raw bằng HMAC-SHA256, giống Java demo:
  //   String signature = generateSignature(queryString, API_SECRET);
  const signature = generateSignature(queryString, secretKey);

  // Trả về raw query + signature, giống Java demo:
  //   "timestamp=" + timestamp + "&signature=" + signature
  return `${queryString}&signature=${signature}`;
}

module.exports = { generateSignature, buildSignedQuery };
