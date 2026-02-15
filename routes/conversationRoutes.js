const express = require("express");
const router = express.Router();
const conversationController = require("../controllers/conversationController");
const auth = require("../middleware/authMiddleware");

router.get("/", auth, conversationController.getUserConversations);
router.get("/:id", auth, conversationController.getConversation);
router.post("/:id/messages", auth, conversationController.sendMessage);
router.get("/:id/messages", auth, conversationController.getMessages);
router.post("/:id/read", auth, conversationController.markAsRead);

module.exports = router;
