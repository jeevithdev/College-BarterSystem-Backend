const User = require("../models/User");
const { verifyTOTP, verifyBackupCode, checkMinimumInterval } = require("../utils/totpService");

/**
 * Middleware to enforce Two-Factor Authentication for sensitive operations
 * Checks if user has 2FA enabled and requires verification for protected actions
 */

/**
 * Require 2FA verification for sensitive operations
 * @param {Object} options - Middleware options
 * @param {boolean} options.required - Whether 2FA is mandatory
 * @param {boolean} options.allowBypass - Allow operation if 2FA not enabled
 * @param {string} options.operation - Description of operation for logging
 * @returns {Function} Express middleware function
 */
const require2FA = (options = {}) => {
  const {
    required = true,
    allowBypass = false,
    operation = "sensitive operation",
    minimumInterval = 10, // Seconds between 2FA verifications
  } = options;

  return async (req, res, next) => {
    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // If 2FA is not enabled
      if (!user.is2FAEnabled()) {
        if (required && !allowBypass) {
          return res.status(403).json({
            message: "Two-Factor Authentication is required for this operation",
            errorCode: "2FA_REQUIRED",
            action: "enable_2fa",
            setupUrl: "/api/auth/2fa/setup",
          });
        }

        // Allow bypass if configured
        if (allowBypass) {
          req.twoFactorVerified = false;
          return next();
        }
      }

      // Check for 2FA code in request
      const twoFactorCode = req.body?.twoFactorCode || req.headers["x-2fa-code"];

      if (!twoFactorCode) {
        return res.status(400).json({
          message: "Two-Factor Authentication code is required",
          errorCode: "2FA_CODE_REQUIRED",
          hint: "Include twoFactorCode in request body or X-2FA-Code header",
        });
      }

      // Check minimum interval to prevent replay attacks
      if (!checkMinimumInterval(user.twoFactor.lastUsed, minimumInterval)) {
        return res.status(429).json({
          message: "Please wait before using another 2FA code",
          errorCode: "2FA_RATE_LIMITED",
          retryAfter: minimumInterval,
        });
      }

      // Verify TOTP code first
      const totpVerification = verifyTOTP(twoFactorCode, user.twoFactor.secret);

      if (totpVerification.valid) {
        // Update last used timestamp
        user.twoFactor.lastUsed = new Date();
        await user.save();

        req.twoFactorVerified = true;
        req.twoFactorMethod = "totp";

        console.log(`2FA verification successful for ${operation}: ${user.email}`);
        return next();
      }

      // Try backup code if TOTP failed
      const backupVerification = verifyBackupCode(twoFactorCode, user.twoFactor.backupCodes);

      if (backupVerification.valid) {
        // Mark backup code as used
        user.useBackupCode(twoFactorCode);
        user.twoFactor.lastUsed = new Date();
        await user.save();

        req.twoFactorVerified = true;
        req.twoFactorMethod = "backup_code";

        console.log(`2FA backup code verification successful for ${operation}: ${user.email}`);
        return next();
      }

      // Both verifications failed
      console.warn(`Failed 2FA verification for ${operation}: ${user.email}`);

      return res.status(401).json({
        message: "Invalid Two-Factor Authentication code",
        errorCode: "2FA_INVALID",
        hint: "Check your authenticator app or try a backup code",
      });
    } catch (error) {
      console.error(`2FA middleware error for ${operation}:`, error);
      return res.status(500).json({
        message: "Two-Factor Authentication verification failed",
        errorCode: "2FA_ERROR",
      });
    }
  };
};

/**
 * Optional 2FA verification - doesn't block if 2FA is not enabled
 * Useful for operations that are enhanced with 2FA but not required
 */
const optional2FA = (options = {}) => {
  return require2FA({
    ...options,
    required: false,
    allowBypass: true,
  });
};

/**
 * Strict 2FA requirement - blocks all operations without 2FA
 * Used for highly sensitive operations like account deletion
 */
const strict2FA = (options = {}) => {
  return require2FA({
    ...options,
    required: true,
    allowBypass: false,
    minimumInterval: 30, // Longer interval for sensitive operations
  });
};

/**
 * 2FA status check middleware
 * Adds 2FA status information to request without requiring verification
 * Useful for conditional UI features
 */
const check2FAStatus = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    req.twoFactorStatus = {
      enabled: user.is2FAEnabled(),
      lastUsed: user.twoFactor.lastUsed,
      backupCodesAvailable: user.is2FAEnabled() ?
        user.twoFactor.backupCodes.filter(bc => !bc.used).length : 0,
    };

    next();
  } catch (error) {
    console.error("2FA status check error:", error);
    // Don't block the request, just continue without 2FA status
    req.twoFactorStatus = { enabled: false, error: true };
    next();
  }
};

/**
 * Middleware to encourage 2FA adoption
 * Adds warnings to responses for non-2FA users performing sensitive operations
 */
const encourage2FA = (req, res, next) => {
  const originalJson = res.json;

  res.json = function(data) {
    if (req.twoFactorStatus && !req.twoFactorStatus.enabled) {
      const enhancedData = {
        ...data,
        securityRecommendation: {
          message: "Enable Two-Factor Authentication for enhanced account security",
          action: "setup_2fa",
          setupUrl: "/api/auth/2fa/setup",
          priority: "high",
        },
      };
      return originalJson.call(this, enhancedData);
    }
    return originalJson.call(this, data);
  };

  next();
};

/**
 * Admin operations requiring 2FA
 * Special middleware for admin-level operations
 */
const requireAdmin2FA = async (req, res, next) => {
  try {
    // First check if user is admin (implement based on your role system)
    const user = await User.findById(req.user.id).populate("roles");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if user has admin role (adjust based on your role system)
    const isAdmin = user.roles?.some(role => role.name === "admin") || false;
    if (!isAdmin) {
      return res.status(403).json({
        message: "Admin privileges required",
        errorCode: "INSUFFICIENT_PRIVILEGES",
      });
    }

    // For admin operations, 2FA is always required
    return strict2FA({
      operation: "admin operation",
      minimumInterval: 60, // 1 minute for admin operations
    })(req, res, next);
  } catch (error) {
    console.error("Admin 2FA middleware error:", error);
    return res.status(500).json({
      message: "Admin verification failed",
      errorCode: "ADMIN_2FA_ERROR",
    });
  }
};

/**
 * Rate limited 2FA verification middleware
 * Prevents brute force attacks on 2FA codes
 */
const rateLimited2FA = (options = {}) => {
  const attempts = new Map(); // In production, use Redis
  const { maxAttempts = 5, windowMs = 5 * 60 * 1000 } = options; // 5 attempts per 5 minutes

  return async (req, res, next) => {
    const userId = req.user.id;
    const now = Date.now();
    const userAttempts = attempts.get(userId) || [];

    // Clean old attempts
    const recentAttempts = userAttempts.filter(attempt => now - attempt < windowMs);

    if (recentAttempts.length >= maxAttempts) {
      return res.status(429).json({
        message: "Too many 2FA verification attempts. Please wait before trying again.",
        errorCode: "2FA_RATE_LIMITED",
        retryAfter: Math.ceil((recentAttempts[0] + windowMs - now) / 1000),
      });
    }

    // Store attempt (success or failure will be recorded after middleware)
    recentAttempts.push(now);
    attempts.set(userId, recentAttempts);

    // Clean up old entries periodically
    if (attempts.size > 1000) {
      const cutoff = now - windowMs;
      attempts.forEach((value, key) => {
        const validAttempts = value.filter(attempt => attempt > cutoff);
        if (validAttempts.length === 0) {
          attempts.delete(key);
        } else {
          attempts.set(key, validAttempts);
        }
      });
    }

    next();
  };
};

module.exports = {
  require2FA,
  optional2FA,
  strict2FA,
  check2FAStatus,
  encourage2FA,
  requireAdmin2FA,
  rateLimited2FA,
};