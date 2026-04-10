const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator");
const authController = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");
const { optional2FA, strict2FA } = require("../middleware/twoFactorMiddleware");

// ─── Validation Rules ─────────────────────────────────────────────────
const registerValidation = [
  body("name").trim().notEmpty().withMessage("Name is required").isLength({ max: 100 }),
  body("email").trim().isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password")
    .isLength({ min: parseInt(process.env.PASSWORD_MIN_LENGTH) || 12 })
    .withMessage(`Password must be at least ${parseInt(process.env.PASSWORD_MIN_LENGTH) || 12} characters`)
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9])/)
    .withMessage("Password must contain uppercase, lowercase, number, and special character"),
];

const loginValidation = [
  body("email").trim().isEmail().withMessage("Valid email is required").normalizeEmail(),
  body("password").notEmpty().withMessage("Password is required"),
];

const refreshTokenValidation = [
  body("refreshToken").notEmpty().withMessage("Refresh token is required"),
];

const logoutValidation = [
  body("refreshToken").notEmpty().withMessage("Refresh token is required"),
];

const forgotPasswordValidation = [
  body("email").trim().isEmail().withMessage("Valid email is required").normalizeEmail(),
];

const resetPasswordValidation = [
  body("token").notEmpty().withMessage("Token is required"),
  body("newPassword")
    .isLength({ min: parseInt(process.env.PASSWORD_MIN_LENGTH) || 12 })
    .withMessage(`New password must be at least ${parseInt(process.env.PASSWORD_MIN_LENGTH) || 12} characters`)
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9])/)
    .withMessage("Password must contain uppercase, lowercase, number, and special character"),
];

const updateProfileValidation = [
  body("name")
    .optional()
    .trim()
    .notEmpty()
    .withMessage("Name cannot be empty")
    .isLength({ max: 100 }),
  body("profileImage")
    .optional()
    .isURL({ require_protocol: true, protocols: ["https"] })
    .withMessage("Profile image must be a valid HTTPS URL"),
];

const changePasswordValidation = [
  body("currentPassword").notEmpty().withMessage("Current password is required"),
  body("newPassword")
    .isLength({ min: parseInt(process.env.PASSWORD_MIN_LENGTH) || 12 })
    .withMessage(`New password must be at least ${parseInt(process.env.PASSWORD_MIN_LENGTH) || 12} characters`)
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9])/)
    .withMessage("Password must contain uppercase, lowercase, number, and special character"),
  body("refreshToken").optional().isString().withMessage("Invalid refresh token format"),
];

const sessionValidation = [
  param("sessionId").isMongoId().withMessage("Invalid session ID"),
];

// ─── Public Routes ────────────────────────────────────────────────────
router.post("/register", registerValidation, authController.register);
router.post("/login", loginValidation, authController.login);
router.post("/refresh", refreshTokenValidation, authController.refreshToken);
router.post("/logout", authMiddleware, logoutValidation, authController.logout);
router.post("/forgot-password", forgotPasswordValidation, authController.forgotPassword);
router.post("/reset-password", resetPasswordValidation, authController.resetPassword);

// ─── Protected Routes ─────────────────────────────────────────────────
router.get("/profile", authMiddleware, authController.getProfile);
router.put("/profile", authMiddleware, updateProfileValidation, authController.updateProfile);
router.put("/change-password", authMiddleware,
  optional2FA({ operation: "password change" }),
  changePasswordValidation,
  authController.changePassword
);
router.delete("/account", authMiddleware,
  strict2FA({ operation: "account deletion", minimumInterval: 60 }),
  authController.deleteAccount
);

// ─── Session Management ──────────────────────────────────────────────
router.get("/sessions", authMiddleware, authController.getActiveSessions);
router.post("/logout-all", authMiddleware,
  optional2FA({ operation: "logout all devices" }),
  authController.logoutAll
);
router.delete("/sessions/:sessionId", authMiddleware,
  optional2FA({ operation: "session revocation" }),
  sessionValidation,
  authController.revokeSession
);

// ─── Public User Profile ──────────────────────────────────────────────
router.get("/users/:id", authController.getPublicProfile);

module.exports = router;
