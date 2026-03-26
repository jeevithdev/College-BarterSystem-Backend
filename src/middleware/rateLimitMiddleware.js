const { getRedisClient } = require("../config/redis");

// Fallback in-memory rate limiter for when Redis is unavailable
const fallbackRateLimit = {};

const rateLimitMiddleware = (options = {}) => {
  const {
    windowMs = 60000,
    maxRequests = 10,
    message = "Too many requests",
    keyPrefix = "rate_limit",
  } = options;

  const windowSec = Math.ceil(windowMs / 1000);

  return async (req, res, next) => {
    const userId = req.user?.id;

    if (!userId) {
      return next();
    }

    const redisKey = `${keyPrefix}:${userId}`;
    const redis = getRedisClient();

    try {
      if (redis && redis.status === 'ready') {
        // Redis-based rate limiting (sliding window log)
        const now = Date.now();
        const cutoff = now - windowMs;

        // Use Redis pipeline for atomic operations
        const pipeline = redis.pipeline();

        // Remove expired entries
        pipeline.zremrangebyscore(redisKey, 0, cutoff);

        // Count current requests in window
        pipeline.zcount(redisKey, cutoff, now);

        // Add current request
        pipeline.zadd(redisKey, now, `${now}-${Math.random()}`);

        // Set expiration for cleanup
        pipeline.expire(redisKey, windowSec * 2);

        const results = await pipeline.exec();

        // Check if we have errors in the pipeline
        if (results.some(result => result[0] !== null)) {
          throw new Error("Redis pipeline error");
        }

        const requestCount = results[1][1]; // zcount result

        if (requestCount >= maxRequests) {
          // Get earliest request timestamp for retry-after calculation
          const earliest = await redis.zrange(redisKey, 0, 0, 'WITHSCORES');
          const retryAfter = earliest.length > 0
            ? Math.ceil((parseFloat(earliest[1]) + windowMs - now) / 1000)
            : Math.ceil(windowSec);

          return res.status(429).json({
            message,
            retryAfter: Math.max(1, retryAfter)
          });
        }
      } else {
        // Fallback to in-memory rate limiting when Redis is unavailable
        console.warn("Redis unavailable, falling back to in-memory rate limiting");

        const now = Date.now();
        const userHistory = fallbackRateLimit[userId] || [];

        const recentRequests = userHistory.filter(timestamp => now - timestamp < windowMs);

        if (recentRequests.length >= maxRequests) {
          return res.status(429).json({
            message,
            retryAfter: Math.ceil((recentRequests[0] + windowMs - now) / 1000)
          });
        }

        recentRequests.push(now);
        fallbackRateLimit[userId] = recentRequests;

        // Clean up old entries periodically
        setTimeout(() => {
          if (fallbackRateLimit[userId]) {
            fallbackRateLimit[userId] = fallbackRateLimit[userId].filter(t => Date.now() - t < windowMs);
            if (fallbackRateLimit[userId].length === 0) {
              delete fallbackRateLimit[userId];
            }
          }
        }, windowMs);
      }
    } catch (error) {
      console.error("Rate limiting error:", error.message);
      // Continue without rate limiting if there's an error
    }

    next();
  };
};

// Utility function to reset rate limits for a user (useful for testing/admin)
const resetUserRateLimit = async (userId, keyPrefix = "rate_limit") => {
  try {
    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      await redis.del(`${keyPrefix}:${userId}`);
      return true;
    }

    // Also clear from fallback
    delete fallbackRateLimit[userId];
    return false; // Redis not available
  } catch (error) {
    console.error("Error resetting rate limit:", error.message);
    return false;
  }
};

// Global rate limiting function (for IP-based limiting)
const globalRateLimitMiddleware = (options = {}) => {
  const {
    windowMs = 60000,
    maxRequests = 100,
    message = "Too many requests from this IP",
    keyPrefix = "global_rate_limit",
  } = options;

  return async (req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    const redisKey = `${keyPrefix}:${clientIP}`;
    const redis = getRedisClient();

    try {
      if (redis && redis.status === 'ready') {
        const requests = await redis.incr(redisKey);

        if (requests === 1) {
          await redis.expire(redisKey, Math.ceil(windowMs / 1000));
        }

        if (requests > maxRequests) {
          const ttl = await redis.ttl(redisKey);
          return res.status(429).json({
            message,
            retryAfter: Math.max(1, ttl)
          });
        }
      }
    } catch (error) {
      console.error("Global rate limiting error:", error.message);
      // Continue without rate limiting if there's an error
    }

    next();
  };
};

module.exports = {
  rateLimitMiddleware,
  globalRateLimitMiddleware,
  resetUserRateLimit
};
