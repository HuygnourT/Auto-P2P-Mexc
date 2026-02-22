// server/middleware/rateLimit.middleware.js

const requestCounts = new Map();

/**
 * Simple rate limiter: max 10 requests per second per IP
 */
function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 1000; // 1 second
  const maxRequests = 10;

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, startTime: now });
    return next();
  }

  const data = requestCounts.get(ip);
  
  if (now - data.startTime > windowMs) {
    requestCounts.set(ip, { count: 1, startTime: now });
    return next();
  }

  if (data.count >= maxRequests) {
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Max 10 requests per second.'
    });
  }

  data.count++;
  next();
}

module.exports = rateLimitMiddleware;
