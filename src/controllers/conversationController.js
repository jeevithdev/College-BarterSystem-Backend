const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const mongoose = require("mongoose");
const { notifyNewMessage } = require("../utils/pushNotificationService");

const MAX_MESSAGE_LENGTH = 2000;
const MESSAGES_PER_PAGE = 50;

const sanitizeText = (text) => {
  if (typeof text !== "string") return "";
  return text
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH)
    .replace(/[<>]/g, "");
};

const checkRateLimit = (userId, limit = 10, windowMs = 60000) => {
  const now = Date.now();
  if (!checkRateLimit.cache) {
    checkRateLimit.cache = new Map();
  }
  
  const userKey = userId.toString();
  const userHistory = checkRateLimit.cache.get(userKey) || [];
  
  const recentRequests = userHistory.filter(timestamp => now - timestamp < windowMs);
  
  if (recentRequests.length >= limit) {
    return false;
  }
  
  recentRequests.push(now);
  checkRateLimit.cache.set(userKey, recentRequests);
  
  setTimeout(() => {
    const updated = (checkRateLimit.cache.get(userKey) || []).filter(t => now - t < windowMs);
    if (updated.length === 0) {
      checkRateLimit.cache.delete(userKey);
    } else {
      checkRateLimit.cache.set(userKey, updated);
    }
  }, windowMs);
  
  return true;
};

exports.getConversations = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const conversations = await Conversation.find({
      participants: req.user.id,
    })
      .populate("participants", "name email profileImage")
      .populate("lastMessage", "text createdAt sender")
      .populate("trade", "status")
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit);

    const conversationsWithUnread = conversations.map(conv => {
      const unread = conv.unreadCount?.get(req.user.id) || 0;
      return {
        ...conv.toObject(),
        unreadCount: unread,
      };
    });

    const total = await Conversation.countDocuments({ participants: req.user.id });

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      conversations: conversationsWithUnread,
    });
  } catch (error) {
    console.error("Error fetching conversations:", error.message);
    res.status(500).json({ message: "Failed to fetch conversations" });
  }
};

exports.getConversation = async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id)
      .populate("participants", "name email profileImage")
      .populate("trade");

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (!conversation.isParticipant(req.user.id)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const unread = conversation.unreadCount?.get(req.user.id) || 0;

    res.json({
      conversation: {
        ...conversation.toObject(),
        unreadCount: unread,
      },
    });
  } catch (error) {
    console.error("Error fetching conversation:", error.message);
    res.status(500).json({ message: "Failed to fetch conversation" });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || MESSAGES_PER_PAGE, 100);
    const skip = (page - 1) * limit;

    const conversation = await Conversation.findById(id);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (!conversation.isParticipant(req.user.id)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const messages = await Message.find({ conversation: id })
      .populate("sender", "name email profileImage")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Message.countDocuments({ conversation: id });

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
      messages: messages.reverse(),
    });
  } catch (error) {
    console.error("Error fetching messages:", error.message);
    res.status(500).json({ message: "Failed to fetch messages" });
  }
};

exports.sendMessage = async (req, res) => {
  let session;
  
  try {
    const { id } = req.params;
    const { text, tempId } = req.body;

    if (!text || typeof text !== "string") {
      return res.status(400).json({ message: "Message text is required" });
    }

    const sanitizedText = sanitizeText(text);
    
    if (!sanitizedText) {
      return res.status(400).json({ message: "Message cannot be empty" });
    }

    if (!checkRateLimit(req.user.id)) {
      return res.status(429).json({ message: "Too many messages. Please wait." });
    }

    session = await mongoose.startSession();
    session.startTransaction();

    const conversation = await Conversation.findById(id).session(session);

    if (!conversation) {
      await session.abortTransaction();
      await session.endSession();
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (!conversation.isParticipant(req.user.id)) {
      await session.abortTransaction();
      await session.endSession();
      return res.status(403).json({ message: "Access denied" });
    }

    const message = new Message({
      conversation: id,
      sender: req.user.id,
      text: sanitizedText,
      readBy: [req.user.id],
    });
    await message.save({ session });

    conversation.lastMessage = message._id;
    conversation.lastMessageAt = new Date();
    
    const currentUnread = conversation.unreadCount?.get(req.user.id) || 0;
    conversation.unreadCount?.set(req.user.id, currentUnread);
    
    await conversation.save({ session });

    await session.commitTransaction();
    await session.endSession();

    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "name email profileImage");

    if (req.io) {
      conversation.participants.forEach(participantId => {
        if (participantId.toString() !== req.user.id) {
          req.io.to(`user:${participantId}`).emit("newMessage", {
            conversationId: id,
            message: populatedMessage,
          });
          
          const unreadKey = participantId.toString();
          const currentCount = conversation.unreadCount?.get(unreadKey) || 0;
          req.io.to(`user:${participantId}`).emit("unreadUpdate", {
            conversationId: id,
            unreadCount: currentCount + 1,
          });
        }
      });
      
      notifyNewMessage(id, message._id, req.user.id).catch(console.error);
    }

    res.status(201).json({
      message: populatedMessage,
    });
  } catch (error) {
    if (session) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        await session.endSession();
      } catch (cleanupError) {
        console.error("Session cleanup error:", cleanupError.message);
      }
    }
    console.error("Error sending message:", error.message);
    res.status(500).json({ message: "Failed to send message" });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;

    const conversation = await Conversation.findById(id);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (!conversation.isParticipant(req.user.id)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const result = await Message.updateMany(
      {
        conversation: id,
        sender: { $ne: req.user.id },
        readBy: { $ne: req.user.id },
      },
      { $addToSet: { readBy: req.user.id } }
    );

    if (conversation.unreadCount) {
      conversation.unreadCount.set(req.user.id, 0);
      await conversation.save();
    }

    res.json({
      message: "Messages marked as read",
      markedCount: result.modifiedCount,
    });
  } catch (error) {
    console.error("Error marking as read:", error.message);
    res.status(500).json({ message: "Failed to mark as read" });
  }
};

exports.createConversation = async (req, res) => {
  let session;
  
  try {
    const { participantId, tradeId } = req.body;

    if (!participantId) {
      return res.status(400).json({ message: "Participant ID is required" });
    }

    if (participantId === req.user.id) {
      return res.status(400).json({ message: "Cannot create conversation with yourself" });
    }

    session = await mongoose.startSession();
    session.startTransaction();

    const existingConversation = await Conversation.findByParticipants(
      [req.user.id, participantId]
    ).session(session);

    if (existingConversation) {
      await session.abortTransaction();
      await session.endSession();
      
      const populated = await Conversation.findById(existingConversation._id)
        .populate("participants", "name email profileImage")
        .populate("trade");
      
      return res.json({
        message: "Conversation already exists",
        conversation: populated,
      });
    }

    const conversation = new Conversation({
      participants: [req.user.id, participantId],
      trade: tradeId || null,
      unreadCount: new Map(),
    });
    await conversation.save({ session });

    await session.commitTransaction();
    await session.endSession();

    const populated = await Conversation.findById(conversation._id)
      .populate("participants", "name email profileImage")
      .populate("trade");

    res.status(201).json({
      message: "Conversation created",
      conversation: populated,
    });
  } catch (error) {
    if (session) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        await session.endSession();
      } catch (cleanupError) {
        console.error("Session cleanup error:", cleanupError.message);
      }
    }
    console.error("Error creating conversation:", error.message);
    res.status(500).json({ message: "Failed to create conversation" });
  }
};

exports.getOrCreateTradeConversation = async (req, res) => {
  try {
    const { tradeId } = req.body;

    if (!tradeId) {
      return res.status(400).json({ message: "Trade ID is required" });
    }

    const conversation = await Conversation.findOne({ trade: tradeId })
      .populate("participants", "name email profileImage")
      .populate("trade");

    if (conversation) {
      if (!conversation.isParticipant(req.user.id)) {
        return res.status(403).json({ message: "Access denied" });
      }
      return res.json({ conversation });
    }

    const Trade = require("../models/Trade");
    const trade = await Trade.findById(tradeId);

    if (!trade) {
      return res.status(404).json({ message: "Trade not found" });
    }

    const participants = [trade.requester.toString(), trade.owner.toString()];
    
    if (!participants.includes(req.user.id)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const newConversation = new Conversation({
      participants,
      trade: tradeId,
      unreadCount: new Map(),
    });
    await newConversation.save();

    const populated = await Conversation.findById(newConversation._id)
      .populate("participants", "name email profileImage")
      .populate("trade");

    res.status(201).json({
      message: "Conversation created for trade",
      conversation: populated,
    });
  } catch (error) {
    console.error("Error creating trade conversation:", error.message);
    res.status(500).json({ message: "Failed to create conversation" });
  }
};

const VALID_EMOJIS = ["👍", "👎", "❤️", "😂", "😮", "😢", "🎉", "🔥"];

exports.addReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji || !VALID_EMOJIS.includes(emoji)) {
      return res.status(400).json({ 
        message: "Invalid emoji",
        validEmojis: VALID_EMOJIS 
      });
    }

    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }

    const conversation = await Conversation.findById(message.conversation);
    if (!conversation || !conversation.isParticipant(req.user.id)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const existingReactionIndex = message.reactions.findIndex(
      r => r.user.toString() === req.user.id
    );

    if (existingReactionIndex !== -1) {
      const existingEmoji = message.reactions[existingReactionIndex].emoji;
      
      if (existingEmoji === emoji) {
        message.reactions.pull({ user: req.user.id });
      } else {
        message.reactions.pull({ user: req.user.id });
        message.reactions.push({ user: req.user.id, emoji });
      }
    } else {
      message.reactions.push({ user: req.user.id, emoji });
    }

    await message.save();

    const updatedMessage = await Message.findById(messageId)
      .populate("sender", "name email profileImage")
      .populate("reactions.user", "name email");

    if (req.io) {
      req.io.to(`conversation:${conversation._id}`).emit("reactionUpdated", {
        conversationId: conversation._id,
        messageId,
        reactions: updatedMessage.reactions,
      });
    }

    res.json({
      message: "Reaction updated",
      reactions: updatedMessage.reactions,
    });
  } catch (error) {
    console.error("Error adding reaction:", error.message);
    res.status(500).json({ message: "Failed to add reaction" });
  }
};

exports.getOnlineUsers = async (req, res) => {
  try {
    const { userIds } = req.body;

    if (!userIds || !Array.isArray(userIds)) {
      return res.status(400).json({ message: "User IDs array is required" });
    }

    const users = await require("../models/User").find({
      _id: { $in: userIds },
      isOnline: true,
    }).select("_id isOnline lastSeen");

    const onlineStatus = {};
    users.forEach(user => {
      onlineStatus[user._id.toString()] = {
        isOnline: true,
        lastSeen: user.lastSeen,
      };
    });

    res.json({ onlineStatus });
  } catch (error) {
    console.error("Error getting online users:", error.message);
    res.status(500).json({ message: "Failed to get online status" });
  }
};

exports.updatePushToken = async (req, res) => {
  try {
    const { pushToken } = req.body;

    if (!pushToken) {
      return res.status(400).json({ message: "Push token is required" });
    }

    const User = require("../models/User");
    await User.findByIdAndUpdate(req.user.id, {
      pushNotificationToken: pushToken,
    });

    res.json({ message: "Push token updated" });
  } catch (error) {
    console.error("Error updating push token:", error.message);
    res.status(500).json({ message: "Failed to update push token" });
  }
};

exports.updateNotificationPreferences = async (req, res) => {
  try {
    const { newMessage, tradeUpdate, tradeRequest } = req.body;

    const update = {};
    if (typeof newMessage === "boolean") update["notificationPreferences.newMessage"] = newMessage;
    if (typeof tradeUpdate === "boolean") update["notificationPreferences.tradeUpdate"] = tradeUpdate;
    if (typeof tradeRequest === "boolean") update["notificationPreferences.tradeRequest"] = tradeRequest;

    const User = require("../models/User");
    await User.findByIdAndUpdate(req.user.id, update);

    res.json({ message: "Notification preferences updated" });
  } catch (error) {
    console.error("Error updating notification preferences:", error.message);
    res.status(500).json({ message: "Failed to update preferences" });
  }
};

exports.sendMessageWithAttachments = async (req, res) => {
  let session;
  
  try {
    const { id } = req.params;
    const { text, tempId, attachments, replyTo } = req.body;

    if ((!text || !text.trim()) && (!attachments || attachments.length === 0)) {
      return res.status(400).json({ message: "Message must have text or attachments" });
    }

    if (!checkRateLimit(req.user.id)) {
      return res.status(429).json({ message: "Too many messages. Please wait." });
    }

    const sanitizedText = text ? sanitizeText(text) : "";

    const validAttachments = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (att.type && att.url && att.name && att.size && att.mimeType) {
          if (att.size <= 10 * 1024 * 1024) {
            validAttachments.push({
              type: att.type,
              url: att.url,
              name: att.name.slice(0, 255),
              size: att.size,
              mimeType: att.mimeType,
            });
          }
        }
      }
    }

    session = await mongoose.startSession();
    session.startTransaction();

    const conversation = await Conversation.findById(id).session(session);

    if (!conversation) {
      await session.abortTransaction();
      await session.endSession();
      return res.status(404).json({ message: "Conversation not found" });
    }

    if (!conversation.isParticipant(req.user.id)) {
      await session.abortTransaction();
      await session.endSession();
      return res.status(403).json({ message: "Access denied" });
    }

    const messageData = {
      conversation: id,
      sender: req.user.id,
      text: sanitizedText,
      readBy: [req.user.id],
    };

    if (validAttachments.length > 0) {
      messageData.attachments = validAttachments;
    }

    if (replyTo) {
      const parentMessage = await Message.findById(replyTo).session(session);
      if (parentMessage && parentMessage.conversation.toString() === id) {
        messageData.replyTo = replyTo;
      }
    }

    const message = new Message(messageData);
    await message.save({ session });

    conversation.lastMessage = message._id;
    conversation.lastMessageAt = new Date();
    
    const currentUnread = conversation.unreadCount?.get(req.user.id) || 0;
    conversation.unreadCount?.set(req.user.id, currentUnread);
    
    await conversation.save({ session });

    await session.commitTransaction();
    await session.endSession();

    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "name email profileImage")
      .populate("replyTo", "text sender");

    if (req.io) {
      conversation.participants.forEach(participantId => {
        if (participantId.toString() !== req.user.id) {
          req.io.to(`user:${participantId}`).emit("newMessage", {
            conversationId: id,
            message: populatedMessage,
          });
          
          const unreadKey = participantId.toString();
          const currentCount = conversation.unreadCount?.get(unreadKey) || 0;
          req.io.to(`user:${participantId}`).emit("unreadUpdate", {
            conversationId: id,
            unreadCount: currentCount + 1,
          });
        }
      });
      
      notifyNewMessage(id, message._id, req.user.id).catch(console.error);
    }

    res.status(201).json({
      message: populatedMessage,
    });
  } catch (error) {
    if (session) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        await session.endSession();
      } catch (cleanupError) {
        console.error("Session cleanup error:", cleanupError.message);
      }
    }
    console.error("Error sending message with attachments:", error.message);
    res.status(500).json({ message: "Failed to send message" });
  }
};
