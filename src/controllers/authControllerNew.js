const User = require("../models/User");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { sendResetEmail } = require("../utils/emailService");
const { validationResult } = require("express-validator");
const {
  generateTokenPair,
  verifyRefreshToken,
  refreshAccessToken,
  revokeRefreshToken,
  extractTokenFromHeader,
  getTokenExpiration,
} = require("../utils/jwtService");

// ─── Helper: extract validation errors ────────────────────────────────────
const checkValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: "Validation failed", errors: errors.array() });
    return false;
  }
  return true;
};

// ─── Helper: get device info from request ─────────────────────────────────
const getDeviceInfo = (req) => {
  const userAgent = req.get("User-Agent") || "Unknown";
  const ip = req.ip || req.connection.remoteAddress || "Unknown";
  return {
    userAgent,
    ipAddress: ip,
    deviceInfo: `${userAgent} from ${ip}`,
  };
};

// ─── Helper: validate password complexity ─────────────────────────────────
const validatePasswordComplexity = (password) => {
  const minLength = parseInt(process.env.PASSWORD_MIN_LENGTH) || 12;
  const requireComplexity = process.env.REQUIRE_PASSWORD_COMPLEXITY === "true";

  const errors = [];

  if (password.length < minLength) {
    errors.push(`Password must be at least ${minLength} characters long`);
  }

  if (requireComplexity) {
    if (!/[a-z]/.test(password)) {
      errors.push("Password must contain at least one lowercase letter");
    }
    if (!/[A-Z]/.test(password)) {
      errors.push("Password must contain at least one uppercase letter");
    }
    if (!/[0-9]/.test(password)) {
      errors.push("Password must contain at least one number");
    }
    if (!/[^a-zA-Z0-9]/.test(password)) {
      errors.push("Password must contain at least one special character");
    }
  }

  // Common password checks
  if (/^(.)\1{2,}/.test(password)) {
    errors.push("Password cannot contain repeated characters");
  }

  const commonPasswords = ["password", "123456", "qwerty", "admin", "welcome"];
  if (commonPasswords.some(common => password.toLowerCase().includes(common))) {
    errors.push("Password cannot contain common words");
  }

  return errors;
};

// ─── Register ─────────────────────────────────────────────────────────────
exports.register = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { name, email, password } = req.body;

    // Additional password complexity validation
    const passwordErrors = validatePasswordComplexity(password);
    if (passwordErrors.length > 0) {
      return res.status(400).json({
        message: "Password does not meet security requirements",
        errors: passwordErrors,
      });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(409).json({ message: "User already exists" });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const salt = await bcrypt.genSalt(saltRounds);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = new User({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      lastPasswordChange: new Date(),
      emailVerified: false, // Require email verification in production
    });

    // Generate tokens
    const { userAgent, ipAddress, deviceInfo } = getDeviceInfo(req);
    const tokens = generateTokenPair({
      id: user._id,
      email: user.email,
      name: user.name,
    });

    // Add refresh token to user
    const refreshExpiration = getTokenExpiration(tokens.refreshToken);
    user.addRefreshToken(tokens.refreshToken, refreshExpiration, deviceInfo, ipAddress, userAgent);

    await user.save();

    // Log registration event
    console.log(`New user registered: ${user.email} from ${ipAddress}`);

    return res.status(201).json({
      message: "Registration successful",
      ...tokens,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.is2FAEnabled(),
      },
    });
  } catch (error) {
    console.error("Registration error:", error);
    return res.status(500).json({ message: error.message || "Registration failed" });
  }
};

// ─── Login ────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { email, password } = req.body;
    const { userAgent, ipAddress, deviceInfo } = getDeviceInfo(req);

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Check account status
    if (user.accountStatus !== "active") {
      return res.status(403).json({
        message: `Account is ${user.accountStatus}. Please contact support.`,
      });
    }

    // Check if account is locked
    if (user.isAccountLocked()) {
      const lockoutMinutes = Math.ceil((user.lockedUntil - Date.now()) / 60000);
      return res.status(423).json({
        message: `Account is locked due to too many failed login attempts. Try again in ${lockoutMinutes} minutes.`,
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      // Increment failed attempts
      await user.incrementFailedAttempts(ipAddress);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Reset failed attempts on successful login
    await user.resetFailedAttempts();

    // Generate tokens
    const tokens = generateTokenPair({
      id: user._id,
      email: user.email,
      name: user.name,
      roles: user.roles,
    });

    // Add refresh token to user
    const refreshExpiration = getTokenExpiration(tokens.refreshToken);
    user.addRefreshToken(tokens.refreshToken, refreshExpiration, deviceInfo, ipAddress, userAgent);

    await user.save();

    // Log successful login
    console.log(`User login: ${user.email} from ${ipAddress}`);

    return res.json({
      message: "Login successful",
      ...tokens,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        profileImage: user.profileImage,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.is2FAEnabled(),
        lastSuccessfulLogin: user.lastSuccessfulLogin,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: error.message || "Login failed" });
  }
};

// ─── Refresh Token ────────────────────────────────────────────────────────
exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ message: "Refresh token is required" });
    }

    // Verify refresh token
    const decoded = await verifyRefreshToken(refreshToken);

    // Find user and validate token exists in database
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    // Check if refresh token exists in user's tokens
    const tokenExists = user.refreshTokens.some(rt => rt.token === refreshToken);
    if (!tokenExists) {
      return res.status(401).json({ message: "Refresh token not found" });
    }

    // Update token usage
    user.updateRefreshTokenUsage(refreshToken);
    await user.save();

    // Generate new access token
    const newTokens = await refreshAccessToken(refreshToken);

    return res.json({
      message: "Token refreshed successfully",
      ...newTokens,
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    return res.status(401).json({ message: "Invalid or expired refresh token" });
  }
};

// ─── Logout ───────────────────────────────────────────────────────────────
exports.logout = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ message: "Refresh token is required" });
    }

    // Revoke the refresh token
    await revokeRefreshToken(refreshToken);

    // Remove from user's token list
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (user) {
      user.removeRefreshToken(refreshToken);
      await user.save();
    }

    console.log(`User logout: ${user?.email || userId}`);

    return res.json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({ message: "Logout failed" });
  }
};

// ─── Logout All Devices ───────────────────────────────────────────────────
exports.logoutAll = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Revoke all refresh tokens
    for (const tokenData of user.refreshTokens) {
      await revokeRefreshToken(tokenData.token);
    }

    // Remove all tokens from user
    user.removeAllRefreshTokens();
    await user.save();

    console.log(`User logout all devices: ${user.email}`);

    return res.json({ message: "Logged out from all devices successfully" });
  } catch (error) {
    console.error("Logout all error:", error);
    return res.status(500).json({ message: "Logout failed" });
  }
};

// ─── Get Active Sessions ──────────────────────────────────────────────────
exports.getActiveSessions = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Filter out expired tokens and format for response
    const activeSessions = user.refreshTokens
      .filter(rt => rt.expiresAt > new Date())
      .map(rt => ({
        id: rt._id,
        deviceInfo: rt.deviceInfo,
        ipAddress: rt.ipAddress,
        createdAt: rt.createdAt,
        lastUsed: rt.lastUsed,
      }))
      .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));

    return res.json({ sessions: activeSessions });
  } catch (error) {
    console.error("Get sessions error:", error);
    return res.status(500).json({ message: "Failed to fetch sessions" });
  }
};

// ─── Revoke Session ───────────────────────────────────────────────────────
exports.revokeSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const session = user.refreshTokens.id(sessionId);
    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    // Revoke the refresh token
    await revokeRefreshToken(session.token);

    // Remove from user's token list
    user.refreshTokens.pull({ _id: sessionId });
    await user.save();

    return res.json({ message: "Session revoked successfully" });
  } catch (error) {
    console.error("Revoke session error:", error);
    return res.status(500).json({ message: "Failed to revoke session" });
  }
};

// ─── Forgot Password ─────────────────────────────────────────────────────
exports.forgotPassword = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { email } = req.body;

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Don't reveal whether the email exists
      return res.status(200).json({ message: "If that email is registered, a reset link has been sent" });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = new Date(Date.now() + 3600000); // 1 hour
    await user.save();

    try {
      await sendResetEmail(email, resetToken);
      return res.status(200).json({ message: "If that email is registered, a reset link has been sent" });
    } catch (emailError) {
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();
      return res.status(500).json({ message: "Failed to send reset email" });
    }
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to process forgot password" });
  }
};

// ─── Reset Password ──────────────────────────────────────────────────────
exports.resetPassword = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { token, newPassword } = req.body;

    // Validate password complexity
    const passwordErrors = validatePasswordComplexity(newPassword);
    if (passwordErrors.length > 0) {
      return res.status(400).json({
        message: "Password does not meet security requirements",
        errors: passwordErrors,
      });
    }

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: "Reset token is invalid or has expired" });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const salt = await bcrypt.genSalt(saltRounds);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    user.password = hashedPassword;
    user.lastPasswordChange = new Date();
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.failedLoginAttempts = 0; // Reset failed attempts
    user.lockedUntil = undefined;

    // Invalidate all existing sessions for security
    for (const tokenData of user.refreshTokens) {
      await revokeRefreshToken(tokenData.token);
    }
    user.removeAllRefreshTokens();

    await user.save();

    console.log(`Password reset completed for user: ${user.email}`);

    return res.status(200).json({ message: "Password reset successful. Please login with your new password." });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to reset password" });
  }
};

// ─── Get Full Profile ─────────────────────────────────────────────────────
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select("-password -resetPasswordToken -resetPasswordExpires -refreshTokens -twoFactor.secret")
      .populate("roles", "name description");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      user: {
        ...user.toObject(),
        twoFactorEnabled: user.is2FAEnabled(),
        accountLocked: user.isAccountLocked(),
      }
    });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to fetch profile" });
  }
};

// ─── Get Public Profile ───────────────────────────────────────────────────
exports.getPublicProfile = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select(
      "name profileImage createdAt isOnline lastSeen"
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({ user });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to fetch profile" });
  }
};

// ─── Update Profile ───────────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { name, profileImage } = req.body;
    const update = {};

    if (name !== undefined) update.name = name.trim();
    if (profileImage !== undefined) update.profileImage = profileImage;

    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select(
      "-password -resetPasswordToken -resetPasswordExpires -refreshTokens -twoFactor.secret"
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({ message: "Profile updated successfully", user });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to update profile" });
  }
};

// ─── Change Password ──────────────────────────────────────────────────────
exports.changePassword = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { currentPassword, newPassword } = req.body;

    // Validate new password complexity
    const passwordErrors = validatePasswordComplexity(newPassword);
    if (passwordErrors.length > 0) {
      return res.status(400).json({
        message: "Password does not meet security requirements",
        errors: passwordErrors,
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const salt = await bcrypt.genSalt(saltRounds);
    user.password = await bcrypt.hash(newPassword, salt);
    user.lastPasswordChange = new Date();

    // Optional: Invalidate other sessions for security (keep current session)
    const currentRefreshToken = req.body.refreshToken;
    for (const tokenData of user.refreshTokens) {
      if (tokenData.token !== currentRefreshToken) {
        await revokeRefreshToken(tokenData.token);
      }
    }
    user.refreshTokens = user.refreshTokens.filter(rt => rt.token === currentRefreshToken);

    await user.save();

    console.log(`Password changed for user: ${user.email}`);

    return res.json({ message: "Password changed successfully" });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to change password" });
  }
};

// ─── Delete Account ───────────────────────────────────────────────────────
exports.deleteAccount = async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ message: "Password is required to delete account" });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    // Revoke all sessions before deletion
    for (const tokenData of user.refreshTokens) {
      await revokeRefreshToken(tokenData.token);
    }

    await user.deleteOne();

    console.log(`Account deleted for user: ${user.email}`);

    return res.json({ message: "Account deleted successfully" });
  } catch (error) {
    return res.status(500).json({ message: error.message || "Failed to delete account" });
  }
};