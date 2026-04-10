const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
const crypto = require("crypto");

/**
 * TOTP (Time-based One-Time Password) Service for Two-Factor Authentication
 * Implements RFC 6238 standard with enhanced security features
 */

// Configuration constants
const TOTP_CONFIG = {
  issuer: process.env.TWO_FACTOR_ISSUER || "Valrix",
  window: parseInt(process.env.TWO_FACTOR_WINDOW) || 2, // Allow 2 time steps (±60 seconds)
  step: 30, // 30-second intervals (standard)
  digits: 6, // 6-digit codes
  algorithm: "sha1", // Standard TOTP algorithm
  encoding: "base32",
};

/**
 * Generate a new TOTP secret for user setup
 * @param {string} userEmail - User's email address
 * @param {string} userName - User's display name
 * @returns {Object} Generated secret and metadata
 */
const generateTOTPSecret = (userEmail, userName) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `${TOTP_CONFIG.issuer} (${userEmail})`,
      account: userEmail,
      issuer: TOTP_CONFIG.issuer,
      length: 32, // 32 bytes = 256 bits for security
    });

    return {
      secret: secret.base32, // Base32 encoding for user storage
      qrCodeUrl: secret.otpauth_url,
      backupCodes: generateBackupCodes(),
    };
  } catch (error) {
    console.error("Error generating TOTP secret:", error);
    throw new Error("Failed to generate 2FA secret");
  }
};

/**
 * Generate backup codes for account recovery
 * @returns {Array<string>} Array of backup codes
 */
const generateBackupCodes = () => {
  const codes = [];
  for (let i = 0; i < 8; i++) {
    // Generate 8-character codes using crypto for security
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    codes.push(code);
  }
  return codes;
};

/**
 * Generate QR code data URL for mobile app setup
 * @param {string} otpAuthUrl - OTP authentication URL
 * @returns {Promise<string>} Data URL for QR code image
 */
const generateQRCode = async (otpAuthUrl) => {
  try {
    const qrCodeDataURL = await qrcode.toDataURL(otpAuthUrl, {
      type: "image/png",
      width: 200,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    });
    return qrCodeDataURL;
  } catch (error) {
    console.error("Error generating QR code:", error);
    throw new Error("Failed to generate QR code");
  }
};

/**
 * Verify a TOTP code against a user's secret
 * @param {string} token - 6-digit TOTP token from user
 * @param {string} secret - User's base32 encoded secret
 * @param {Object} options - Verification options
 * @returns {Object} Verification result with details
 */
const verifyTOTP = (token, secret, options = {}) => {
  try {
    if (!token || !secret) {
      return {
        valid: false,
        error: "Token and secret are required",
      };
    }

    // Clean token (remove spaces, ensure 6 digits)
    const cleanToken = token.replace(/\s/g, "");
    if (!/^\d{6}$/.test(cleanToken)) {
      return {
        valid: false,
        error: "Invalid token format. Must be 6 digits.",
      };
    }

    const isValid = speakeasy.totp.verify({
      secret: secret,
      encoding: TOTP_CONFIG.encoding,
      token: cleanToken,
      step: TOTP_CONFIG.step,
      window: options.window || TOTP_CONFIG.window,
      time: options.time || Date.now(),
    });

    return {
      valid: isValid,
      timestamp: Date.now(),
      window: options.window || TOTP_CONFIG.window,
    };
  } catch (error) {
    console.error("Error verifying TOTP:", error);
    return {
      valid: false,
      error: "Verification failed",
    };
  }
};

/**
 * Generate current TOTP code (for testing/debugging)
 * @param {string} secret - Base32 encoded secret
 * @returns {string} Current 6-digit TOTP code
 */
const generateTOTP = (secret) => {
  try {
    return speakeasy.totp({
      secret: secret,
      encoding: TOTP_CONFIG.encoding,
      step: TOTP_CONFIG.step,
      digits: TOTP_CONFIG.digits,
    });
  } catch (error) {
    console.error("Error generating TOTP:", error);
    throw new Error("Failed to generate TOTP code");
  }
};

/**
 * Verify a backup code against user's backup codes
 * @param {string} code - Backup code entered by user
 * @param {Array<Object>} backupCodes - User's backup codes from database
 * @returns {Object} Verification result
 */
const verifyBackupCode = (code, backupCodes) => {
  if (!code || !Array.isArray(backupCodes)) {
    return {
      valid: false,
      error: "Invalid code or backup codes not found",
    };
  }

  const cleanCode = code.replace(/\s/g, "").toUpperCase();

  // Find unused backup code that matches
  const backupCode = backupCodes.find(
    bc => bc.code === cleanCode && !bc.used
  );

  if (!backupCode) {
    return {
      valid: false,
      error: "Invalid or already used backup code",
    };
  }

  return {
    valid: true,
    codeId: backupCode._id || backupCode.code,
    timestamp: Date.now(),
  };
};

/**
 * Get time remaining until next TOTP code
 * @returns {number} Seconds remaining until code changes
 */
const getTimeRemaining = () => {
  const now = Math.floor(Date.now() / 1000);
  const timeStep = TOTP_CONFIG.step;
  return timeStep - (now % timeStep);
};

/**
 * Validate TOTP secret format
 * @param {string} secret - Base32 encoded secret to validate
 * @returns {boolean} True if secret is valid format
 */
const validateTOTPSecret = (secret) => {
  if (!secret || typeof secret !== "string") {
    return false;
  }

  // Check if it's valid base32
  const base32Regex = /^[A-Z2-7]+$/;
  return base32Regex.test(secret) && secret.length >= 16;
};

/**
 * Create manual entry key for users who can't scan QR codes
 * @param {string} secret - Base32 encoded secret
 * @returns {string} Formatted secret for manual entry
 */
const formatManualEntryKey = (secret) => {
  // Format as groups of 4 characters for easier manual entry
  return secret.replace(/(.{4})/g, "$1 ").trim();
};

/**
 * Check if minimum time has passed since last TOTP usage
 * Prevents replay attacks within the same time window
 * @param {Date} lastUsed - Last time 2FA was used
 * @param {number} minimumIntervalSeconds - Minimum seconds between uses
 * @returns {boolean} True if enough time has passed
 */
const checkMinimumInterval = (lastUsed, minimumIntervalSeconds = 30) => {
  if (!lastUsed) return true;

  const timeDiff = (Date.now() - new Date(lastUsed).getTime()) / 1000;
  return timeDiff >= minimumIntervalSeconds;
};

/**
 * Generate recovery information for user
 * @param {Array<string>} backupCodes - Available backup codes
 * @returns {Object} Recovery information
 */
const getRecoveryInfo = (backupCodes) => {
  const usedCodes = backupCodes.filter(bc => bc.used).length;
  const availableCodes = backupCodes.length - usedCodes;

  return {
    totalBackupCodes: backupCodes.length,
    usedBackupCodes: usedCodes,
    availableBackupCodes: availableCodes,
    needsNewCodes: availableCodes <= 2, // Recommend regeneration when 2 or fewer left
  };
};

/**
 * Create TOTP setup instructions for user
 * @param {string} issuer - Service name
 * @param {string} secret - Formatted secret key
 * @returns {Object} Setup instructions
 */
const getSetupInstructions = (issuer, secret) => {
  return {
    steps: [
      `Install an authenticator app (Google Authenticator, Authy, 1Password, etc.)`,
      `Scan the QR code with your authenticator app`,
      `If you can't scan the QR code, manually enter this key: ${formatManualEntryKey(secret)}`,
      `Enter the 6-digit code from your app to verify setup`,
      `Save your backup codes in a secure location`,
    ],
    supportedApps: [
      "Google Authenticator",
      "Microsoft Authenticator",
      "Authy",
      "1Password",
      "LastPass Authenticator",
      "Bitwarden",
    ],
    security: {
      keyRotation: "Secret keys cannot be changed once setup is complete",
      backupCodes: "Each backup code can only be used once",
      deviceSecurity: "Keep your authenticator device secure and backed up",
    },
  };
};

module.exports = {
  generateTOTPSecret,
  generateBackupCodes,
  generateQRCode,
  verifyTOTP,
  generateTOTP,
  verifyBackupCode,
  getTimeRemaining,
  validateTOTPSecret,
  formatManualEntryKey,
  checkMinimumInterval,
  getRecoveryInfo,
  getSetupInstructions,
  TOTP_CONFIG,
};