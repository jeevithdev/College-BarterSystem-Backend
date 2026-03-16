const jwt = require("jsonwebtoken");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");

const VALID_EMOJIS = ["👍", "👎", "❤️", "😂", "😮", "😢", "🎉", "🔥"];

const setupWebSocket = (io) => {
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      return next(new Error("Authentication required"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRETKEY);
      socket.userId = decoded.id;
      next();
    } catch (err) {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", async (socket) => {
    console.log(`User connected: ${socket.userId}`);
    
    try {
      await User.findByIdAndUpdate(socket.userId, {
        isOnline: true,
        lastSeen: new Date(),
      });
    } catch (error) {
      console.error("Error updating online status:", error.message);
    }
    
    socket.join(`user:${socket.userId}`);

    socket.on("getOnlineStatus", async (userIds) => {
      try {
        const users = await User.find({
          _id: { $in: userIds },
        }).select("_id isOnline lastSeen");

        const status = {};
        users.forEach(user => {
          status[user._id.toString()] = {
            isOnline: user.isOnline,
            lastSeen: user.lastSeen,
          };
        });

        socket.emit("onlineStatus", status);
      } catch (error) {
        console.error("Error getting online status:", error.message);
      }
    });

    socket.on("joinConversation", async (conversationId) => {
      try {
        const conversation = await Conversation.findById(conversationId);
        
        if (!conversation || !conversation.isParticipant(socket.userId)) {
          socket.emit("error", { message: "Access denied" });
          return;
        }

        socket.join(`conversation:${conversationId}`);
        console.log(`User ${socket.userId} joined conversation ${conversationId}`);

        const otherParticipants = conversation.participants
          .filter(p => p.toString() !== socket.userId)
          .map(p => p.toString());
        
        if (otherParticipants.length > 0) {
          const users = await User.find({
            _id: { $in: otherParticipants },
          }).select("_id isOnline lastSeen");

          const status = {};
          users.forEach(user => {
            status[user._id.toString()] = {
              isOnline: user.isOnline,
              lastSeen: user.lastSeen,
            };
          });

          socket.emit("onlineStatus", status);
        }
      } catch (error) {
        socket.emit("error", { message: "Failed to join conversation" });
      }
    });

    socket.on("leaveConversation", (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
      console.log(`User ${socket.userId} left conversation ${conversationId}`);
    });

    socket.on("typing", (conversationId) => {
      socket.to(`conversation:${conversationId}`).emit("userTyping", {
        conversationId,
        userId: socket.userId,
      });
    });

    socket.on("stopTyping", (conversationId) => {
      socket.to(`conversation:${conversationId}`).emit("userStoppedTyping", {
        conversationId,
        userId: socket.userId,
      });
    });

    socket.on("sendMessage", async (data) => {
      const { conversationId, text, tempId, attachments, replyTo } = data;

      if ((!text || typeof text !== "string" || text.trim().length === 0) && (!attachments || attachments.length === 0)) {
        socket.emit("error", { message: "Message cannot be empty" });
        return;
      }

      if (text && text.length > 2000) {
        socket.emit("error", { message: "Message too long" });
        return;
      }

      try {
        const conversation = await Conversation.findById(conversationId);
        
        if (!conversation || !conversation.isParticipant(socket.userId)) {
          socket.emit("error", { message: "Access denied" });
          return;
        }

        const sanitizedText = text ? text.trim().slice(0, 2000) : "";

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

        const messageData = {
          conversation: conversationId,
          sender: socket.userId,
          text: sanitizedText,
          readBy: [socket.userId],
        };

        if (validAttachments.length > 0) {
          messageData.attachments = validAttachments;
        }

        if (replyTo) {
          const parentMessage = await Message.findById(replyTo);
          if (parentMessage && parentMessage.conversation.toString() === conversationId) {
            messageData.replyTo = replyTo;
          }
        }

        const message = new Message(messageData);
        await message.save();

        conversation.lastMessage = message._id;
        conversation.lastMessageAt = new Date();
        
        if (!conversation.unreadCount) {
          conversation.unreadCount = new Map();
        }
        
        const currentUnread = conversation.unreadCount.get(socket.userId.toString()) || 0;
        conversation.unreadCount.set(socket.userId.toString(), currentUnread);
        
        await conversation.save();

        const populatedMessage = await Message.findById(message._id)
          .populate("sender", "name email profileImage")
          .populate("replyTo", "text sender");

        io.to(`conversation:${conversationId}`).emit("newMessage", {
          conversationId,
          message: populatedMessage,
          tempId,
        });

        conversation.participants.forEach(participantId => {
          if (participantId.toString() !== socket.userId) {
            const unreadKey = participantId.toString();
            const currentCount = conversation.unreadCount?.get(unreadKey) || 0;
            io.to(`user:${participantId}`).emit("unreadUpdate", {
              conversationId,
              unreadCount: currentCount + 1,
            });
          }
        });

      } catch (error) {
        console.error("WebSocket sendMessage error:", error.message);
        socket.emit("messageError", { 
          tempId, 
          message: "Failed to send message" 
        });
      }
    });

    socket.on("addReaction", async (data) => {
      const { messageId, emoji } = data;

      if (!VALID_EMOJIS.includes(emoji)) {
        socket.emit("error", { message: "Invalid emoji" });
        return;
      }

      try {
        const message = await Message.findById(messageId);

        if (!message) {
          socket.emit("error", { message: "Message not found" });
          return;
        }

        const conversation = await Conversation.findById(message.conversation);
        if (!conversation || !conversation.isParticipant(socket.userId)) {
          socket.emit("error", { message: "Access denied" });
          return;
        }

        const existingReactionIndex = message.reactions.findIndex(
          r => r.user.toString() === socket.userId
        );

        if (existingReactionIndex !== -1) {
          const existingEmoji = message.reactions[existingReactionIndex].emoji;
          
          if (existingEmoji === emoji) {
            message.reactions.pull({ user: socket.userId });
          } else {
            message.reactions.pull({ user: socket.userId });
            message.reactions.push({ user: socket.userId, emoji });
          }
        } else {
          message.reactions.push({ user: socket.userId, emoji });
        }

        await message.save();

        const updatedMessage = await Message.findById(messageId)
          .populate("reactions.user", "name email");

        io.to(`conversation:${conversation._id}`).emit("reactionUpdated", {
          conversationId: conversation._id,
          messageId,
          reactions: updatedMessage.reactions,
        });

      } catch (error) {
        console.error("WebSocket addReaction error:", error.message);
        socket.emit("error", { message: "Failed to add reaction" });
      }
    });

    socket.on("markRead", async (conversationId) => {
      try {
        const conversation = await Conversation.findById(conversationId);
        
        if (!conversation || !conversation.isParticipant(socket.userId)) {
          return;
        }

        await Message.updateMany(
          {
            conversation: conversationId,
            sender: { $ne: socket.userId },
            readBy: { $ne: socket.userId },
          },
          { $addToSet: { readBy: socket.userId } }
        );

        if (conversation.unreadCount) {
          conversation.unreadCount.set(socket.userId.toString(), 0);
          await conversation.save();
        }

        socket.to(`conversation:${conversationId}`).emit("messagesRead", {
          conversationId,
          readBy: socket.userId,
        });

      } catch (error) {
        console.error("WebSocket markRead error:", error.message);
      }
    });

    socket.on("disconnect", async () => {
      console.log(`User disconnected: ${socket.userId}`);
      
      try {
        await User.findByIdAndUpdate(socket.userId, {
          isOnline: false,
          lastSeen: new Date(),
        });
        
        io.emit("userOffline", { userId: socket.userId });
      } catch (error) {
        console.error("Error updating offline status:", error.message);
      }
    });
  });

  return io;
};

module.exports = { setupWebSocket };
