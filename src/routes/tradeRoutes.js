const express = require("express");
const { body, param, query } = require("express-validator");
const router = express.Router();
const tradeController = require("../controllers/tradeController");
const auth = require("../middleware/authMiddleware");

// ─── Validation Rules ─────────────────────────────────────────────────
const createTradeValidation = [
  body("offeredItem").isMongoId().withMessage("Valid offered item ID is required"),
  body("requestedItem").isMongoId().withMessage("Valid requested item ID is required"),
];

// ─── Routes ───────────────────────────────────────────────────────────
router.post("/request", auth, createTradeValidation, tradeController.createTradeRequest);
router.get("/myrequests", auth, tradeController.myRequests);
router.get("/requests-for-me", auth, tradeController.requestsForMe);
router.post("/:id/accept", auth, tradeController.acceptTrade);
router.post("/:id/confirm", auth, tradeController.confirmTrade);
router.post("/:id/complete", auth, tradeController.completeTrade);
router.post("/:id/reject", auth, tradeController.rejectTrade);
router.post("/:id/cancel", auth, tradeController.cancelTrade);
router.post("/check-expired", auth, tradeController.checkExpiredTrades);

module.exports = router;