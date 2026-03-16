const rateLimit = {};

const rateLimitMiddleware = (options = {}) => {
  const {
    windowMs = 60000,
    maxRequests = 10,
    message = "Too many requests",
  } = options;

  return (req, res, next) => {
    const userId = req.user?.id;
    
    if (!userId) {
      return next();
    }

    const now = Date.now();
    const userHistory = rateLimit[userId] || [];
    
    const recentRequests = userHistory.filter(timestamp => now - timestamp < windowMs);
    
    if (recentRequests.length >= maxRequests) {
      return res.status(429).json({ 
        message,
        retryAfter: Math.ceil((recentRequests[0] + windowMs - now) / 1000)
      });
    }

    recentRequests.push(now);
    rateLimit[userId] = recentRequests;

    setTimeout(() => {
      if (rateLimit[userId]) {
        rateLimit[userId] = rateLimit[userId].filter(t => Date.now() - t < windowMs);
        if (rateLimit[userId].length === 0) {
          delete rateLimit[userId];
        }
      }
    }, windowMs);

    next();
  };
};

module.exports = { rateLimitMiddleware };
