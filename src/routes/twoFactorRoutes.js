const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const twoFactorController = require("../controllers/twoFactorController");
const authMiddleware = require("../middleware/authMiddleware");
const { check2FAStatus, encourage2FA, rateLimited2FA } = require("../middleware/twoFactorMiddleware");

// ─── Validation Rules ─────────────────────────────────────────────────────
const setupValidation = []; // No input needed for setup initiation

const verifySetupValidation = [
  body("code")
    .isLength({ min: 6, max: 6 })
    .withMessage("2FA code must be exactly 6 digits")
    .matches(/^\d{6}$/)
    .withMessage("2FA code must contain only numbers"),
];

const verify2FAValidation = [
  body("code")
    .isLength({ min: 6, max: 8 })
    .withMessage("Code must be 6-digit TOTP or 8-character backup code")
    .matches(/^[A-Z0-9]{6,8}$/)
    .withMessage("Invalid code format"),
];

const disable2FAValidation = [
  body("password")
    .notEmpty()
    .withMessage("Password is required to disable 2FA"),
  body("twoFactorCode")
    .isLength({ min: 6, max: 8 })
    .withMessage("Current 2FA code is required to disable 2FA")
    .matches(/^[A-Z0-9]{6,8}$/)
    .withMessage("Invalid 2FA code format"),
];

const generateBackupCodesValidation = [
  body("password")
    .notEmpty()
    .withMessage("Password is required to generate new backup codes"),
  body("twoFactorCode")
    .isLength({ min: 6, max: 6 })
    .withMessage("Current 2FA code is required")
    .matches(/^\d{6}$/)
    .withMessage("2FA code must be 6 digits"),
];

// ─── Apply common middleware ──────────────────────────────────────────────
// All 2FA routes require authentication and rate limiting
router.use(authMiddleware);
router.use(rateLimited2FA({ maxAttempts: 10, windowMs: 5 * 60 * 1000 }));
router.use(check2FAStatus);
router.use(encourage2FA);

// ─── 2FA Management Routes ────────────────────────────────────────────────

/**
 * GET /api/auth/2fa/status
 * Get current 2FA status for the authenticated user
 */
router.get("/status", twoFactorController.get2FAStatus);

/**
 * POST /api/auth/2fa/setup
 * Initiate 2FA setup - generates secret and QR code
 */
router.post("/setup", setupValidation, twoFactorController.setup2FA);

/**
 * POST /api/auth/2fa/verify-setup
 * Complete 2FA setup by verifying the TOTP code
 */
router.post("/verify-setup", verifySetupValidation, twoFactorController.verify2FASetup);

/**
 * POST /api/auth/2fa/verify
 * Verify 2FA code for enabled accounts
 */
router.post("/verify", verify2FAValidation, twoFactorController.verify2FA);

/**
 * POST /api/auth/2fa/disable
 * Disable 2FA (requires password + current 2FA code)
 */
router.post("/disable", disable2FAValidation, twoFactorController.disable2FA);

/**
 * POST /api/auth/2fa/backup-codes
 * Generate new backup codes (requires password + current 2FA code)
 */
router.post("/backup-codes", generateBackupCodesValidation, twoFactorController.generateNewBackupCodes);

/**
 * DELETE /api/auth/2fa/cancel-setup
 * Cancel ongoing 2FA setup process
 */
router.delete("/cancel-setup", twoFactorController.cancel2FASetup);

module.exports = router;