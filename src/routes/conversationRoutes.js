const express = require("express");
const { body, param, query } = require("express-validator");
const router = express.Router();
const conversationController = require("../controllers/conversationController");
const auth = require("../middleware/authMiddleware");
const { rateLimitMiddleware } = require("../middleware/rateLimitMiddleware");

// ─── Validation Rules ─────────────────────────────────────────────────
const createConversationValidation = [
  body("participantId").isMongoId().withMessage("Valid participant ID is required"),
  body("tradeId").optional().isMongoId().withMessage("Trade ID must be a valid ID"),
];

const sendMessageValidation = [
  body("text").trim().notEmpty().withMessage("Message text is required").isLength({ max: 2000 }),
];

// ─── Conversation CRUD ────────────────────────────────────────────────
router.post("/", auth, createConversationValidation, conversationController.createConversation);
router.get("/", auth, conversationController.getConversations);

// FIX: getOrCreateTradeConversation now reads from query params
router.get("/trade", auth, conversationController.getOrCreateTradeConversation);

// FIX: getOnlineUsers now reads from query params
router.get("/online", auth, conversationController.getOnlineUsers);

router.get("/:id", auth, conversationController.getConversation);
router.get("/:id/messages", auth, conversationController.getMessages);

// Messages with rate limiting (middleware only — removed duplicate in-controller rate limit)
router.post(
  "/:id/messages",
  auth,
  rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }),
  sendMessageValidation,
  conversationController.sendMessage
);
router.post(
  "/:id/messages/attachments",
  auth,
  rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }),
  conversationController.sendMessageWithAttachments
);
router.post("/:id/read", auth, conversationController.markAsRead);

// ─── Reactions ────────────────────────────────────────────────────────
router.post("/messages/:messageId/reactions", auth, conversationController.addReaction);

// ─── Push & Notifications ─────────────────────────────────────────────
router.post("/push-token", auth, conversationController.updatePushToken);
router.post("/notifications", auth, conversationController.updateNotificationPreferences);

module.exports = router;
