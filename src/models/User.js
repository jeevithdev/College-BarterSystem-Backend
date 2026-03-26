const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  resetPasswordToken: {
    type: String,
  },
  resetPasswordExpires: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  profileImage: {
    type: String,
  },
  isOnline: {
    type: Boolean,
    default: false,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
  },
  pushNotificationToken: {
    type: String,
  },
  notificationPreferences: {
    newMessage: { type: Boolean, default: true },
    tradeUpdate: { type: Boolean, default: true },
    tradeRequest: { type: Boolean, default: true },
  },
  unreadConversations: {
    type: Map,
    of: Number,
    default: {},
  },
  // ─── Security Fields ──────────────────────────────────────────────────
  // Refresh Token Management
  refreshTokens: [{
    token: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    deviceInfo: {
      type: String,
      maxLength: 500,
    },
    ipAddress: {
      type: String,
      maxLength: 45, // IPv6 length
    },
    userAgent: {
      type: String,
      maxLength: 1000,
    },
    lastUsed: {
      type: Date,
      default: Date.now,
    },
  }],
  // Account Lockout and Security
  failedLoginAttempts: {
    type: Number,
    default: 0,
  },
  lockedUntil: {
    type: Date,
  },
  lastPasswordChange: {
    type: Date,
    default: Date.now,
  },
  lastSuccessfulLogin: {
    type: Date,
  },
  // Two-Factor Authentication
  twoFactor: {
    secret: {
      type: String, // Base32 encoded TOTP secret
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    backupCodes: [{
      code: String,
      used: {
        type: Boolean,
        default: false,
      },
      usedAt: Date,
    }],
    lastUsed: {
      type: Date,
    },
    qrCodeUrl: {
      type: String, // Temporary field for setup process
    },
  },
  // Role-Based Access Control
  roles: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Role",
  }],
  // Security Preferences
  securityPreferences: {
    requirePasswordOnSensitiveActions: {
      type: Boolean,
      default: true,
    },
    allowMultipleSessions: {
      type: Boolean,
      default: true,
    },
    sessionTimeout: {
      type: Number,
      default: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
    },
  },
  // Audit Fields
  emailVerified: {
    type: Boolean,
    default: false,
  },
  emailVerificationToken: {
    type: String,
  },
  emailVerificationExpires: {
    type: Date,
  },
  accountStatus: {
    type: String,
    enum: ["active", "suspended", "deactivated", "pending_verification"],
    default: "active",
  },
}, { timestamps: true });

userSchema.methods.updateOnlineStatus = async function(isOnline) {
  this.isOnline = isOnline;
  this.lastSeen = new Date();
  await this.save();
};

// ─── Account Security Methods ─────────────────────────────────────────────
// Check if account is currently locked
userSchema.methods.isAccountLocked = function() {
  return !!(this.lockedUntil && this.lockedUntil > Date.now());
};

// Increment failed login attempts and lock account if necessary
userSchema.methods.incrementFailedAttempts = async function(ipAddress = null) {
  const maxAttempts = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5;
  const lockoutTimeMinutes = parseInt(process.env.LOCKOUT_TIME_MINUTES) || 30;

  this.failedLoginAttempts = (this.failedLoginAttempts || 0) + 1;

  // Progressive lockout: 5min -> 15min -> 30min -> 1hour
  let lockoutTime;
  if (this.failedLoginAttempts <= maxAttempts) {
    lockoutTime = 5; // 5 minutes for first lockout
  } else if (this.failedLoginAttempts <= maxAttempts * 2) {
    lockoutTime = 15; // 15 minutes
  } else if (this.failedLoginAttempts <= maxAttempts * 3) {
    lockoutTime = 30; // 30 minutes
  } else {
    lockoutTime = 60; // 1 hour for repeated attempts
  }

  if (this.failedLoginAttempts >= maxAttempts) {
    this.lockedUntil = new Date(Date.now() + lockoutTime * 60 * 1000);
  }

  await this.save();

  // Log security event (optional audit logging)
  if (ipAddress) {
    console.warn(`Failed login attempt for user ${this._id} from IP ${ipAddress}. Attempts: ${this.failedLoginAttempts}`);
  }
};

// Reset failed login attempts (call on successful login)
userSchema.methods.resetFailedAttempts = async function() {
  if (this.failedLoginAttempts || this.lockedUntil) {
    this.failedLoginAttempts = 0;
    this.lockedUntil = undefined;
    this.lastSuccessfulLogin = new Date();
    await this.save();
  }
};

// ─── Refresh Token Methods ────────────────────────────────────────────────
// Add a new refresh token
userSchema.methods.addRefreshToken = function(token, expiresAt, deviceInfo = null, ipAddress = null, userAgent = null) {
  const maxTokens = 5; // Limit concurrent sessions

  // Remove expired tokens
  this.refreshTokens = this.refreshTokens.filter(rt => rt.expiresAt > new Date());

  // Remove oldest tokens if we're at the limit
  if (this.refreshTokens.length >= maxTokens) {
    this.refreshTokens.sort((a, b) => a.createdAt - b.createdAt);
    this.refreshTokens = this.refreshTokens.slice(-(maxTokens - 1));
  }

  // Add new token
  this.refreshTokens.push({
    token,
    expiresAt,
    deviceInfo: deviceInfo ? deviceInfo.substring(0, 500) : null,
    ipAddress,
    userAgent: userAgent ? userAgent.substring(0, 1000) : null,
    lastUsed: new Date(),
  });
};

// Remove a specific refresh token
userSchema.methods.removeRefreshToken = function(token) {
  this.refreshTokens = this.refreshTokens.filter(rt => rt.token !== token);
};

// Remove all refresh tokens (for logout all devices)
userSchema.methods.removeAllRefreshTokens = function() {
  this.refreshTokens = [];
};

// Update refresh token last used timestamp
userSchema.methods.updateRefreshTokenUsage = function(token) {
  const tokenDoc = this.refreshTokens.find(rt => rt.token === token);
  if (tokenDoc) {
    tokenDoc.lastUsed = new Date();
  }
};

// ─── Two-Factor Authentication Methods ─────────────────────────────────────
// Check if 2FA is enabled and properly configured
userSchema.methods.is2FAEnabled = function() {
  return this.twoFactor.enabled && this.twoFactor.secret;
};

// Generate new backup codes for 2FA
userSchema.methods.generateBackupCodes = function() {
  const crypto = require("crypto");
  const codes = [];

  for (let i = 0; i < 8; i++) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    codes.push({
      code,
      used: false,
    });
  }

  this.twoFactor.backupCodes = codes;
  return codes.map(c => c.code);
};

// Use a backup code
userSchema.methods.useBackupCode = function(code) {
  const backupCode = this.twoFactor.backupCodes.find(
    bc => bc.code === code.toUpperCase() && !bc.used
  );

  if (backupCode) {
    backupCode.used = true;
    backupCode.usedAt = new Date();
    return true;
  }

  return false;
};

// ─── Role and Permission Methods ───────────────────────────────────────────
// Check if user has a specific role
userSchema.methods.hasRole = function(roleName) {
  if (!this.populated("roles")) {
    throw new Error("Roles must be populated to check role membership");
  }
  return this.roles.some(role => role.name === roleName);
};

// ─── Database Indexes ─────────────────────────────────────────────────────
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ "refreshTokens.token": 1 });
userSchema.index({ "refreshTokens.expiresAt": 1 });
userSchema.index({ lockedUntil: 1 });
userSchema.index({ lastSuccessfulLogin: -1 });
userSchema.index({ accountStatus: 1 });
userSchema.index({ "twoFactor.enabled": 1 });
userSchema.index({ isOnline: 1, lastSeen: -1 });

module.exports = mongoose.model("User", userSchema);
