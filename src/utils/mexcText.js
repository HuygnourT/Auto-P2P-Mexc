/**
 * Tiện ích chuyển đổi nội dung Automated Reply / Advertiser Terms cho MEXC.
 *
 * MEXC ký chữ ký trên query string RAW (xem utils/crypto.js), nên các field text
 * phải được percent-encode UTF-8 TRƯỚC khi đưa vào query (vd: "Chị" → "Ch%E1%BB%8B").
 * Encode chặt như RFC 3986: ngoài encodeURIComponent còn encode thêm ! ' ( ) *
 * để khớp định dạng đang chạy ổn định (vd: "(" → "%28").
 */

// Chuỗi Automated Reply mặc định (đang dùng trước đây, dạng UTF-8 đã encode)
const DEFAULT_AUTO_REPLY_ENCODED =
  'Xin%20Chao%20Anh%28Ch%E1%BB%8B%29%20Em%20%C4%91ang%20online.%20Ch%C3%BAc%20Anh%28Ch%E1%BB%8B%29%20trade%20xxx%20t%C3%A0i%20kho%E1%BA%A3n.%20Em%20x%E1%BB%AD%20l%C3%AD%20l%E1%BB%87nh%20tu%E1%BA%A7n%20t%E1%BB%B1%20l%E1%BB%87nh%20n%C3%A0o%20%C6%B0u%20ti%C3%AAn%20tr%C6%B0%E1%BB%9Bc%20s%E1%BA%BD%20thanh%20to%C3%A1n%20tr%C6%B0%E1%BB%9Bc.%20Anh%20%28%20Ch%E1%BB%8B%20%29%20th%E1%BA%A5y%20b%C3%AAn%20em%20x%E1%BB%AD%20l%C3%AD%20nhanh%20g%E1%BB%8Dn%20c%C3%B3%20th%E1%BB%83%20%C4%91%C3%A1nh%20gi%C3%A1%20t%C3%ADch%20c%E1%BB%B1c%20gi%C3%BAp.%20Em%20c%E1%BA%A3m%20%C6%A1n%0A%0AN%E1%BB%99i%20dung%20thanh%20to%C3%A1n%20m%E1%BA%B7c%20%C4%91%E1%BB%8Bnh%20b%C3%AAn%20em%20lu%C3%B4n%20lu%C3%B4n%20l%C3%A0%20t%C3%AAn%20ng%C6%B0%E1%BB%9Di%20chuy%E1%BB%83n%20ti%E1%BB%81n%20kh%C3%B4ng%20ph%E1%BA%A3i%20m%C3%A3%20l%E1%BB%87nh';

// Chuỗi đã ở dạng encode: chỉ gồm ký tự an toàn + có ít nhất 1 cụm %XX
function looksEncoded(str) {
  return /^[A-Za-z0-9\-_.~%]*$/.test(str) && /%[0-9A-Fa-f]{2}/.test(str);
}

/** Tiếng Việt → UTF-8 percent-encoded (không encode lại nếu đã encode sẵn) */
function encodeMexcText(str) {
  if (str == null) return '';
  const s = String(str).replace(/\r\n/g, '\n');
  if (s === '') return '';
  if (looksEncoded(s)) return s;
  return encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** UTF-8 percent-encoded → Tiếng Việt (giữ nguyên nếu không phải chuỗi encode) */
function decodeMexcText(str) {
  if (str == null) return '';
  const s = String(str);
  if (!looksEncoded(s)) return s;
  try { return decodeURIComponent(s); } catch { return s; }
}

const DEFAULT_AUTO_REPLY = decodeMexcText(DEFAULT_AUTO_REPLY_ENCODED);
const DEFAULT_TRADE_TERMS = '';

module.exports = {
  encodeMexcText,
  decodeMexcText,
  DEFAULT_AUTO_REPLY,
  DEFAULT_AUTO_REPLY_ENCODED,
  DEFAULT_TRADE_TERMS,
};
