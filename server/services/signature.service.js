// server/services/signature.service.js
const crypto = require('crypto');

class SignatureService {
  /**
   * Generate MEXC API signature
   * @param {Object} params - Query parameters
   * @param {string} secretKey - API Secret Key
   * @returns {Object} - params with timestamp and signature appended
   */
  static generateSignature(params, secretKey) {
    const timestamp = Date.now();
    
    const queryParams = {
      ...params,
      timestamp
    };

    // Build query string
    const queryString = Object.keys(queryParams)
      .map(key => `${key}=${queryParams[key]}`)
      .join('&');

    // HMAC SHA256 signature
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(queryString)
      .digest('hex');

    return {
      queryString,
      signature,
      timestamp
    };
  }

  /**
   * Build signed URL
   */
  static buildSignedUrl(baseUrl, path, params, secretKey) {
    const { queryString, signature, timestamp } = this.generateSignature(params, secretKey);
    return `${baseUrl}${path}?${queryString}&signature=${signature}`;
  }
}

module.exports = SignatureService;
