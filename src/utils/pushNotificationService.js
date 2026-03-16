const mongoose = require("mongoose");
const User = require("../models/User");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");

const sendPushNotification = async (userId, title, body, data = {}) => {
  try {
    const user = await User.findById(userId);
    
    if (!user || !user.pushNotificationToken) {
      return;
    }

    const preferences = user.notificationPreferences;
    if (preferences && preferences.newMessage === false) {
      return;
    }

    if (process.env.FCM_SERVER_KEY) {
      const fcmResponse = await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `key=${process.env.FCM_SERVER_KEY}`,
        },
        body: JSON.stringify({
          to: user.pushNotificationToken,
          notification: {
            title,
            body,
          },
          data: {
            ...data,
            click_action: "OPEN_CHAT",
          },
          webpush: {
            notification: {
              icon: "/icon.png",
              badge: "/badge.png",
            },
            fcm_options: {
              link: data.conversationId ? `/chat/${data.conversationId}` : "/",
            },
          },
        }),
      });

      const result = await fcmResponse.json();
      
      if (result.failure === 1) {
        if (result.results[0].error === "NotRegistered" || result.results[0].error === "InvalidRegistration") {
          user.pushNotificationToken = undefined;
          await user.save();
        }
      }
      
      return result;
    }

    console.log(`Push notification to ${user.email}: ${title} - ${body}`);
    return { success: true };
  } catch (error) {
    console.error("Error sending push notification:", error.message);
    return { success: false, error: error.message };
  }
};

const notifyNewMessage = async (conversationId, messageId, senderId) => {
  try {
    const conversation = await Conversation.findById(conversationId)
      .populate("participants", "name pushNotificationToken notificationPreferences");

    if (!conversation) return;

    const sender = await User.findById(senderId);
    const senderName = sender?.name || "Someone";

    for (const participant of conversation.participants) {
      if (participant._id.toString() === senderId.toString()) continue;

      const preferences = participant.notificationPreferences;
      if (preferences && preferences.newMessage === false) continue;

      const hasActiveSocket = global.io?.sockets?.adapter?.rooms?.get(`user:${participant._id}`);
      if (hasActiveSocket) continue;

      await sendPushNotification(
        participant._id,
        `${senderName} sent a message`,
        conversation.lastMessage?.text?.substring(0, 100) || "New message",
        {
          type: "new_message",
          conversationId,
          messageId,
        }
      );
    }
  } catch (error) {
    console.error("Error notifying new message:", error.message);
  }
};

const notifyTradeUpdate = async (userId, tradeId, message) => {
  try {
    const user = await User.findById(userId);
    
    if (!user) return;

    const preferences = user.notificationPreferences;
    if (preferences && preferences.tradeUpdate === false) return;

    await sendPushNotification(
      userId,
      "Trade Update",
      message,
      {
        type: "trade_update",
        tradeId,
      }
    );
  } catch (error) {
    console.error("Error notifying trade update:", error.message);
  }
};

const notifyTradeRequest = async (userId, tradeId, requesterName) => {
  try {
    const user = await User.findById(userId);
    
    if (!user) return;

    const preferences = user.notificationPreferences;
    if (preferences && preferences.tradeRequest === false) return;

    await sendPushNotification(
      userId,
      "New Trade Request",
      `${requesterName} wants to trade with you`,
      {
        type: "trade_request",
        tradeId,
      }
    );
  } catch (error) {
    console.error("Error notifying trade request:", error.message);
  }
};

module.exports = {
  sendPushNotification,
  notifyNewMessage,
  notifyTradeUpdate,
  notifyTradeRequest,
};
