const express = require("express");
const router = express.Router();
const conversationController = require("../controllers/conversationController");
const auth = require("../middleware/authMiddleware");
const { rateLimitMiddleware } = require("../middleware/rateLimitMiddleware");

router.post("/", auth, conversationController.createConversation);
router.get("/trade", auth, conversationController.getOrCreateTradeConversation);
router.get("/", auth, conversationController.getConversations);
router.get("/online", auth, conversationController.getOnlineUsers);
router.get("/:id", auth, conversationController.getConversation);
router.get("/:id/messages", auth, conversationController.getMessages);
router.post("/:id/messages", auth, rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }), conversationController.sendMessage);
router.post("/:id/messages/attachments", auth, rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }), conversationController.sendMessageWithAttachments);
router.post("/:id/read", auth, conversationController.markAsRead);

router.post("/messages/:messageId/reactions", auth, conversationController.addReaction);

router.post("/push-token", auth, conversationController.updatePushToken);
router.post("/notifications", auth, conversationController.updateNotificationPreferences);

module.exports = router;
