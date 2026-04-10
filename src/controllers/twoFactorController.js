const User = require("../models/User");
const { validationResult } = require("express-validator");
const {
  generateTOTPSecret,
  generateQRCode,
  verifyTOTP,
  verifyBackupCode,
  validateTOTPSecret,
  getRecoveryInfo,
  getSetupInstructions,
  checkMinimumInterval,
} = require("../utils/totpService");

// ─── Helper: extract validation errors ────────────────────────────────────
const checkValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: "Validation failed", errors: errors.array() });
    return false;
  }
  return true;
};

// ─── Setup 2FA - Generate Secret and QR Code ─────────────────────────────
exports.setup2FA = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if 2FA is already enabled
    if (user.is2FAEnabled()) {
      return res.status(400).json({
        message: "2FA is already enabled. Disable first to reconfigure.",
        twoFactorEnabled: true,
      });
    }

    // Generate new TOTP secret and backup codes
    const secretData = generateTOTPSecret(user.email, user.name);
    const qrCodeDataURL = await generateQRCode(secretData.qrCodeUrl);

    // Store the secret temporarily (not enabled until verified)
    user.twoFactor.secret = secretData.secret;
    user.twoFactor.enabled = false;
    user.twoFactor.qrCodeUrl = secretData.qrCodeUrl; // Clear this after setup
    user.twoFactor.backupCodes = secretData.backupCodes.map(code => ({
      code,
      used: false,
    }));

    await user.save();

    // Get setup instructions
    const instructions = getSetupInstructions("Valrix", secretData.secret);

    console.log(`2FA setup initiated for user: ${user.email}`);

    return res.json({
      message: "2FA setup initiated. Scan QR code and verify with your authenticator app.",
      qrCode: qrCodeDataURL,
      manualEntryKey: secretData.secret,
      backupCodes: secretData.backupCodes, // Show once during setup
      instructions,
      setupStep: "scan_qr_code",
    });
  } catch (error) {
    console.error("2FA setup error:", error);
    return res.status(500).json({ message: "Failed to setup 2FA" });
  }
};

// ─── Verify 2FA Setup ─────────────────────────────────────────────────────
exports.verify2FASetup = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { code } = req.body;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.twoFactor.secret) {
      return res.status(400).json({
        message: "2FA setup not initiated. Please start setup first.",
      });
    }

    if (user.is2FAEnabled()) {
      return res.status(400).json({
        message: "2FA is already enabled",
        twoFactorEnabled: true,
      });
    }

    // Verify the TOTP code
    const verification = verifyTOTP(code, user.twoFactor.secret);
    if (!verification.valid) {
      return res.status(400).json({
        message: "Invalid verification code. Please try again.",
        error: verification.error,
      });
    }

    // Enable 2FA
    user.twoFactor.enabled = true;
    user.twoFactor.lastUsed = new Date();
    user.twoFactor.qrCodeUrl = undefined; // Clear temporary QR code data

    await user.save();

    console.log(`2FA enabled successfully for user: ${user.email}`);

    return res.json({
      message: "2FA has been successfully enabled for your account.",
      twoFactorEnabled: true,
      backupCodesRemaining: user.twoFactor.backupCodes.filter(bc => !bc.used).length,
      setupComplete: true,
    });
  } catch (error) {
    console.error("2FA verification error:", error);
    return res.status(500).json({ message: "Failed to verify 2FA setup" });
  }
};

// ─── Verify 2FA Code ──────────────────────────────────────────────────────
exports.verify2FA = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { code } = req.body;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.is2FAEnabled()) {
      return res.status(400).json({
        message: "2FA is not enabled for your account",
        twoFactorEnabled: false,
      });
    }

    // Check minimum interval to prevent replay attacks
    if (!checkMinimumInterval(user.twoFactor.lastUsed, 10)) {
      return res.status(429).json({
        message: "Please wait before using another 2FA code",
      });
    }

    // Try TOTP verification first
    const verification = verifyTOTP(code, user.twoFactor.secret);

    if (verification.valid) {
      user.twoFactor.lastUsed = new Date();
      await user.save();

      return res.json({
        message: "2FA verification successful",
        verified: true,
        method: "totp",
      });
    }

    // If TOTP fails, try backup code
    const backupVerification = verifyBackupCode(code, user.twoFactor.backupCodes);

    if (backupVerification.valid) {
      // Mark backup code as used
      user.useBackupCode(code);
      user.twoFactor.lastUsed = new Date();
      await user.save();

      const recoveryInfo = getRecoveryInfo(user.twoFactor.backupCodes);

      return res.json({
        message: "2FA verification successful using backup code",
        verified: true,
        method: "backup_code",
        warning: recoveryInfo.needsNewCodes ?
          "You have 2 or fewer backup codes left. Consider regenerating them." : null,
        backupCodesRemaining: recoveryInfo.availableBackupCodes,
      });
    }

    // Both verification methods failed
    console.warn(`Failed 2FA verification attempt for user: ${user.email}`);

    return res.status(400).json({
      message: "Invalid 2FA code or backup code",
      verified: false,
    });
  } catch (error) {
    console.error("2FA verification error:", error);
    return res.status(500).json({ message: "Failed to verify 2FA" });
  }
};

// ─── Disable 2FA ──────────────────────────────────────────────────────────
exports.disable2FA = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { password, twoFactorCode } = req.body;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.is2FAEnabled()) {
      return res.status(400).json({
        message: "2FA is not enabled for your account",
        twoFactorEnabled: false,
      });
    }

    // Verify password
    const bcrypt = require("bcryptjs");
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        message: "Invalid password. Password required to disable 2FA.",
      });
    }

    // Verify current 2FA code
    const verification = verifyTOTP(twoFactorCode, user.twoFactor.secret);
    if (!verification.valid) {
      // Also try backup code
      const backupVerification = verifyBackupCode(twoFactorCode, user.twoFactor.backupCodes);
      if (!backupVerification.valid) {
        return res.status(400).json({
          message: "Invalid 2FA code. Please provide current 2FA code to disable.",
        });
      }
    }

    // Disable 2FA
    user.twoFactor.enabled = false;
    user.twoFactor.secret = undefined;
    user.twoFactor.backupCodes = [];
    user.twoFactor.lastUsed = undefined;
    user.twoFactor.qrCodeUrl = undefined;

    await user.save();

    console.log(`2FA disabled for user: ${user.email}`);

    return res.json({
      message: "2FA has been successfully disabled for your account.",
      twoFactorEnabled: false,
      warning: "Your account is now less secure. Consider re-enabling 2FA for better protection.",
    });
  } catch (error) {
    console.error("2FA disable error:", error);
    return res.status(500).json({ message: "Failed to disable 2FA" });
  }
};

// ─── Generate New Backup Codes ───────────────────────────────────────────
exports.generateNewBackupCodes = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { password, twoFactorCode } = req.body;
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.is2FAEnabled()) {
      return res.status(400).json({
        message: "2FA is not enabled for your account",
        twoFactorEnabled: false,
      });
    }

    // Verify password
    const bcrypt = require("bcryptjs");
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        message: "Invalid password. Password required to generate new backup codes.",
      });
    }

    // Verify current 2FA code
    const verification = verifyTOTP(twoFactorCode, user.twoFactor.secret);
    if (!verification.valid) {
      return res.status(400).json({
        message: "Invalid 2FA code. Please provide current 2FA code.",
      });
    }

    // Generate new backup codes
    const newBackupCodes = user.generateBackupCodes();
    await user.save();

    console.log(`New backup codes generated for user: ${user.email}`);

    return res.json({
      message: "New backup codes generated successfully",
      backupCodes: newBackupCodes,
      warning: "Save these codes securely. Old backup codes are no longer valid.",
      instructions: [
        "Store these codes in a secure location",
        "Each code can only be used once",
        "Use backup codes only when you can't access your authenticator app",
        "Consider generating new codes if you suspect they've been compromised",
      ],
    });
  } catch (error) {
    console.error("Backup codes generation error:", error);
    return res.status(500).json({ message: "Failed to generate new backup codes" });
  }
};

// ─── Get 2FA Status ───────────────────────────────────────────────────────
exports.get2FAStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const recoveryInfo = user.is2FAEnabled() ?
      getRecoveryInfo(user.twoFactor.backupCodes) : null;

    return res.json({
      twoFactorEnabled: user.is2FAEnabled(),
      lastUsed: user.twoFactor.lastUsed,
      setupInProgress: !!(user.twoFactor.secret && !user.twoFactor.enabled),
      recoveryInfo: recoveryInfo ? {
        availableBackupCodes: recoveryInfo.availableBackupCodes,
        needsNewCodes: recoveryInfo.needsNewCodes,
      } : null,
      recommendations: {
        enable2FA: !user.is2FAEnabled(),
        generateNewCodes: recoveryInfo?.needsNewCodes || false,
        setupComplete: user.is2FAEnabled(),
      },
    });
  } catch (error) {
    console.error("2FA status error:", error);
    return res.status(500).json({ message: "Failed to get 2FA status" });
  }
};

// ─── Cancel 2FA Setup ─────────────────────────────────────────────────────
exports.cancel2FASetup = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Only allow canceling if setup is in progress but not completed
    if (user.is2FAEnabled()) {
      return res.status(400).json({
        message: "2FA is already enabled. Use disable endpoint to turn it off.",
      });
    }

    if (!user.twoFactor.secret) {
      return res.status(400).json({
        message: "No 2FA setup in progress",
      });
    }

    // Clear setup data
    user.twoFactor.secret = undefined;
    user.twoFactor.qrCodeUrl = undefined;
    user.twoFactor.backupCodes = [];
    user.twoFactor.enabled = false;

    await user.save();

    console.log(`2FA setup canceled for user: ${user.email}`);

    return res.json({
      message: "2FA setup canceled successfully",
      twoFactorEnabled: false,
    });
  } catch (error) {
    console.error("2FA setup cancel error:", error);
    return res.status(500).json({ message: "Failed to cancel 2FA setup" });
  }
};