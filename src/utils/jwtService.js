const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { getRedisClient } = require("../config/redis");

// Validate JWT secrets are 256-bit (64 hex characters minimum)
const validateJWTSecrets = () => {
  const accessSecret = process.env.JWT_ACCESS_SECRET;
  const refreshSecret = process.env.JWT_REFRESH_SECRET;

  if (!accessSecret || !refreshSecret) {
    throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET environment variables are required");
  }

  if (accessSecret.length < 64) {
    throw new Error("JWT_ACCESS_SECRET must be at least 64 characters (256-bit) for security");
  }

  if (refreshSecret.length < 64) {
    throw new Error("JWT_REFRESH_SECRET must be at least 64 characters (256-bit) for security");
  }

  // Ensure they're different
  if (accessSecret === refreshSecret) {
    throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different");
  }

  return true;
};

// Generate cryptographically secure random JWT secrets
const generateSecureJWTSecret = () => {
  return crypto.randomBytes(32).toString("hex"); // 64 character hex string
};

// Token Types
const TOKEN_TYPES = {
  ACCESS: "access",
  REFRESH: "refresh",
};

// Default expiration times
const DEFAULT_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || "15m";
const DEFAULT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "7d";

/**
 * Generate access token with short expiration
 * @param {Object} payload - Token payload (should include user ID)
 * @param {string} expiresIn - Token expiration time
 * @returns {string} JWT access token
 */
const generateAccessToken = (payload, expiresIn = DEFAULT_ACCESS_EXPIRES_IN) => {
  validateJWTSecrets();

  const tokenPayload = {
    ...payload,
    type: TOKEN_TYPES.ACCESS,
    iat: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(tokenPayload, process.env.JWT_ACCESS_SECRET, {
    expiresIn,
    issuer: "valrix-backend",
    audience: "valrix-users",
  });
};

/**
 * Generate refresh token with long expiration
 * @param {Object} payload - Token payload (should include user ID)
 * @param {string} expiresIn - Token expiration time
 * @returns {string} JWT refresh token
 */
const generateRefreshToken = (payload, expiresIn = DEFAULT_REFRESH_EXPIRES_IN) => {
  validateJWTSecrets();

  const tokenPayload = {
    ...payload,
    type: TOKEN_TYPES.REFRESH,
    jti: crypto.randomUUID(), // Unique token ID for revocation
    iat: Math.floor(Date.now() / 1000),
  };

  return jwt.sign(tokenPayload, process.env.JWT_REFRESH_SECRET, {
    expiresIn,
    issuer: "valrix-backend",
    audience: "valrix-users",
  });
};

/**
 * Generate token pair (access + refresh)
 * @param {Object} payload - Token payload
 * @returns {Object} { accessToken, refreshToken, expiresIn }
 */
const generateTokenPair = (payload) => {
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  // Parse expiration time to seconds for client
  const expiresIn = parseExpirationTime(DEFAULT_ACCESS_EXPIRES_IN);

  return {
    accessToken,
    refreshToken,
    expiresIn,
    tokenType: "Bearer",
  };
};

/**
 * Verify access token
 * @param {string} token - JWT token to verify
 * @returns {Object} Decoded token payload
 */
const verifyAccessToken = (token) => {
  validateJWTSecrets();

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
      issuer: "valrix-backend",
      audience: "valrix-users",
    });

    if (decoded.type !== TOKEN_TYPES.ACCESS) {
      throw new Error("Invalid token type");
    }

    return decoded;
  } catch (error) {
    throw new Error(`Invalid access token: ${error.message}`);
  }
};

/**
 * Verify refresh token
 * @param {string} token - JWT refresh token to verify
 * @returns {Object} Decoded token payload
 */
const verifyRefreshToken = async (token) => {
  validateJWTSecrets();

  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET, {
      issuer: "valrix-backend",
      audience: "valrix-users",
    });

    if (decoded.type !== TOKEN_TYPES.REFRESH) {
      throw new Error("Invalid token type");
    }

    // Check if token is blacklisted
    if (await isTokenBlacklisted(decoded.jti)) {
      throw new Error("Token has been revoked");
    }

    return decoded;
  } catch (error) {
    throw new Error(`Invalid refresh token: ${error.message}`);
  }
};

/**
 * Blacklist a refresh token by its JTI
 * @param {string} jti - Token ID to blacklist
 * @param {number} expirationSeconds - How long to keep in blacklist
 */
const blacklistToken = async (jti, expirationSeconds = 60 * 60 * 24 * 7) => {
  try {
    const redis = getRedisClient();
    if (redis && redis.status === "ready") {
      await redis.setex(`blacklist:${jti}`, expirationSeconds, "1");
      return true;
    }
    console.warn("Redis unavailable, unable to blacklist token");
    return false;
  } catch (error) {
    console.error("Error blacklisting token:", error.message);
    return false;
  }
};

/**
 * Check if a token is blacklisted
 * @param {string} jti - Token ID to check
 * @returns {boolean} True if blacklisted
 */
const isTokenBlacklisted = async (jti) => {
  try {
    const redis = getRedisClient();
    if (redis && redis.status === "ready") {
      const exists = await redis.exists(`blacklist:${jti}`);
      return exists === 1;
    }
    return false; // Assume not blacklisted if Redis unavailable
  } catch (error) {
    console.error("Error checking token blacklist:", error.message);
    return false;
  }
};

/**
 * Get token from Authorization header
 * @param {string} authHeader - Authorization header value
 * @returns {string|null} Token or null if not found
 */
const extractTokenFromHeader = (authHeader) => {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.split(" ")[1];
};

/**
 * Parse expiration time string to seconds
 * @param {string} timeString - Time string like "15m", "1h", "7d"
 * @returns {number} Seconds
 */
const parseExpirationTime = (timeString) => {
  const unit = timeString.slice(-1);
  const value = parseInt(timeString.slice(0, -1));

  switch (unit) {
    case "s": return value;
    case "m": return value * 60;
    case "h": return value * 60 * 60;
    case "d": return value * 60 * 60 * 24;
    default: return 900; // Default to 15 minutes
  }
};

/**
 * Get token expiration date
 * @param {string} token - JWT token
 * @returns {Date} Expiration date
 */
const getTokenExpiration = (token) => {
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.exp) {
      return new Date(decoded.exp * 1000);
    }
    return null;
  } catch (error) {
    return null;
  }
};

/**
 * Refresh an access token using a valid refresh token
 * @param {string} refreshToken - Valid refresh token
 * @returns {Object} New token pair
 */
const refreshAccessToken = async (refreshToken) => {
  try {
    // Verify the refresh token
    const decoded = await verifyRefreshToken(refreshToken);

    // Generate new access token with same payload (minus JWT-specific fields)
    const userPayload = {
      id: decoded.id,
      email: decoded.email,
      // Add any other user fields that should persist
    };

    const newAccessToken = generateAccessToken(userPayload);
    const expiresIn = parseExpirationTime(DEFAULT_ACCESS_EXPIRES_IN);

    return {
      accessToken: newAccessToken,
      expiresIn,
      tokenType: "Bearer",
    };
  } catch (error) {
    throw new Error(`Token refresh failed: ${error.message}`);
  }
};

/**
 * Revoke all tokens for a user (by blacklisting refresh token)
 * @param {string} refreshToken - Refresh token to revoke
 */
const revokeRefreshToken = async (refreshToken) => {
  try {
    const decoded = jwt.decode(refreshToken);
    if (decoded && decoded.jti) {
      const expirationSeconds = decoded.exp ? decoded.exp - Math.floor(Date.now() / 1000) : 604800; // 7 days default
      return await blacklistToken(decoded.jti, Math.max(0, expirationSeconds));
    }
    return false;
  } catch (error) {
    console.error("Error revoking refresh token:", error.message);
    return false;
  }
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  verifyAccessToken,
  verifyRefreshToken,
  blacklistToken,
  isTokenBlacklisted,
  extractTokenFromHeader,
  getTokenExpiration,
  refreshAccessToken,
  revokeRefreshToken,
  generateSecureJWTSecret,
  validateJWTSecrets,
  TOKEN_TYPES,
};