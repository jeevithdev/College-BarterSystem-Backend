const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");

router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/forgot-password", authController.forgotPassword);
router.post("/reset-password", authController.resetPassword);

router.get("/profile", authMiddleware, (req, res) => {
  res.json({ message: "Profile accessed successfully", userId: req.user.id });
});

module.exports = router;
