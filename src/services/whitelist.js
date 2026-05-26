const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Service quản lý danh sách whitelist thương nhân.
 * Thương nhân trong whitelist sẽ bị bỏ qua khi auto-pricer tìm giá tốt nhất
 * (không xét giá của họ trong apFindBestPrice).
 * Dữ liệu lưu trong file data/whitelist.json.
 */

const WHITELIST_PATH = path.join(__dirname, '..', '..', 'data', 'whitelist.json');

/**
 * Đọc whitelist từ file.
 * @returns {string[]} Danh sách tên thương nhân
 */
function getWhitelist() {
  try {
    if (!fs.existsSync(WHITELIST_PATH)) {
      const dir = path.dirname(WHITELIST_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(WHITELIST_PATH, JSON.stringify({ merchants: [] }, null, 2));
      return [];
    }
    const raw = fs.readFileSync(WHITELIST_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data.merchants || [];
  } catch (err) {
    logger.error(`[Whitelist] Read error: ${err.message}`);
    return [];
  }
}

/**
 * Lưu whitelist vào file.
 * @param {string[]} merchants - Danh sách tên thương nhân
 */
function saveWhitelist(merchants) {
  try {
    const dir = path.dirname(WHITELIST_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WHITELIST_PATH, JSON.stringify({ merchants }, null, 2));
    logger.info(`[Whitelist] Saved ${merchants.length} merchants`);
  } catch (err) {
    logger.error(`[Whitelist] Write error: ${err.message}`);
    throw err;
  }
}

/**
 * Thêm thương nhân vào whitelist (không trùng, case-insensitive).
 * @param {string} name - Tên thương nhân (nickName)
 * @returns {string[]} Danh sách mới sau khi thêm
 */
function addMerchant(name) {
  const merchants = getWhitelist();
  const trimmed = name.trim();
  if (!trimmed) return merchants;
  if (merchants.some(m => m.toLowerCase() === trimmed.toLowerCase())) {
    return merchants; // đã tồn tại
  }
  merchants.push(trimmed);
  saveWhitelist(merchants);
  return merchants;
}

/**
 * Xóa thương nhân khỏi whitelist.
 * @param {string} name - Tên thương nhân cần xóa
 * @returns {string[]} Danh sách mới sau khi xóa
 */
function removeMerchant(name) {
  let merchants = getWhitelist();
  const trimmed = name.trim().toLowerCase();
  merchants = merchants.filter(m => m.toLowerCase() !== trimmed);
  saveWhitelist(merchants);
  return merchants;
}

module.exports = { getWhitelist, saveWhitelist, addMerchant, removeMerchant };
