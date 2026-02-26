/**
 * Tiện ích ghi log với 4 mức độ: DEBUG, INFO, WARN, ERROR.
 * Mỗi dòng log tự động gắn thời gian và mức độ để dễ debug.
 */

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = LOG_LEVELS.DEBUG;

/** Định dạng thời gian hiện tại thành chuỗi "YYYY-MM-DD HH:mm:ss" */
function formatTime() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const logger = {
  /** Log thông tin debug chi tiết (chỉ hiện khi level <= DEBUG) */
  debug: (...args) => currentLevel <= LOG_LEVELS.DEBUG && console.log(`[${formatTime()}] [DEBUG]`, ...args),

  /** Log thông tin hoạt động bình thường */
  info: (...args) => currentLevel <= LOG_LEVELS.INFO && console.log(`[${formatTime()}] [INFO]`, ...args),

  /** Log cảnh báo, không phải lỗi nhưng cần chú ý */
  warn: (...args) => currentLevel <= LOG_LEVELS.WARN && console.warn(`[${formatTime()}] [WARN]`, ...args),

  /** Log lỗi nghiêm trọng */
  error: (...args) => currentLevel <= LOG_LEVELS.ERROR && console.error(`[${formatTime()}] [ERROR]`, ...args),
};

module.exports = logger;
