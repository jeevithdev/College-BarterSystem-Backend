/**
 * Centralized notification service that provides access to Socket.IO
 * without using global variables. This service maintains a clean
 * architecture by using dependency injection.
 */

let ioInstance = null;

// Initialize the notification service with Socket.IO instance
const initializeNotificationService = (io) => {
  ioInstance = io;
  console.log("✅ Notification service initialized");
};

/**
 * Send notification to a specific user
 * @param {string} userId - User ID
 * @param {string} event - Socket event name
 * @param {Object} data - Data to send
 */
const sendToUser = (userId, event, data) => {
  if (!ioInstance) {
    console.warn("Notification service not initialized");
    return false;
  }

  ioInstance.to(`user:${userId}`).emit(event, data);
  return true;
};

/**
 * Send notification to a specific room
 * @param {string} room - Room name
 * @param {string} event - Socket event name
 * @param {Object} data - Data to send
 */
const sendToRoom = (room, event, data) => {
  if (!ioInstance) {
    console.warn("Notification service not initialized");
    return false;
  }

  ioInstance.to(room).emit(event, data);
  return true;
};

/**
 * Broadcast notification to all connected clients
 * @param {string} event - Socket event name
 * @param {Object} data - Data to send
 */
const broadcast = (event, data) => {
  if (!ioInstance) {
    console.warn("Notification service not initialized");
    return false;
  }

  ioInstance.emit(event, data);
  return true;
};

/**
 * Check if a user has active socket connections
 * @param {string} userId - User ID
 * @returns {boolean} True if user has active connections
 */
const hasActiveConnection = (userId) => {
  if (!ioInstance) {
    return false;
  }

  const userRoom = `user:${userId}`;
  const room = ioInstance.sockets.adapter.rooms.get(userRoom);
  return !!(room && room.size > 0);
};

/**
 * Get active connections count
 * @returns {number} Number of active connections
 */
const getActiveConnections = () => {
  if (!ioInstance) {
    return 0;
  }

  return ioInstance.engine?.clientsCount || 0;
};

/**
 * Get users in a specific room
 * @param {string} roomName - Room name
 * @returns {Array} Array of socket IDs in the room
 */
const getUsersInRoom = (roomName) => {
  if (!ioInstance) {
    return [];
  }

  const room = ioInstance.sockets.adapter.rooms.get(roomName);
  return room ? Array.from(room) : [];
};

/**
 * Send typing indicator to conversation participants
 * @param {string} conversationId - Conversation ID
 * @param {string} userId - User who is typing
 * @param {boolean} isTyping - Typing status
 */
const sendTypingIndicator = (conversationId, userId, isTyping) => {
  const event = isTyping ? "userTyping" : "userStoppedTyping";
  sendToRoom(`conversation:${conversationId}`, event, {
    conversationId,
    userId,
  });
};

/**
 * Send real-time trade update
 * @param {string} tradeId - Trade ID
 * @param {Array} participantIds - Array of participant user IDs
 * @param {Object} tradeData - Trade data
 */
const sendTradeUpdate = (tradeId, participantIds, tradeData) => {
  participantIds.forEach(userId => {
    sendToUser(userId, "tradeUpdate", {
      tradeId,
      trade: tradeData,
    });
  });
};

/**
 * Send unread count update to user
 * @param {string} userId - User ID
 * @param {string} conversationId - Conversation ID
 * @param {number} unreadCount - Unread message count
 */
const sendUnreadUpdate = (userId, conversationId, unreadCount) => {
  sendToUser(userId, "unreadUpdate", {
    conversationId,
    unreadCount,
  });
};

/**
 * Notify user status change (online/offline)
 * @param {string} userId - User ID
 * @param {boolean} isOnline - Online status
 */
const notifyUserStatusChange = (userId, isOnline) => {
  broadcast("userStatusChanged", {
    userId,
    isOnline,
    timestamp: new Date().toISOString(),
  });
};

/**
 * Send system notification to user
 * @param {string} userId - User ID
 * @param {string} type - Notification type
 * @param {string} title - Notification title
 * @param {string} message - Notification message
 * @param {Object} metadata - Additional metadata
 */
const sendSystemNotification = (userId, type, title, message, metadata = {}) => {
  sendToUser(userId, "systemNotification", {
    type,
    title,
    message,
    timestamp: new Date().toISOString(),
    ...metadata,
  });
};

module.exports = {
  initializeNotificationService,
  sendToUser,
  sendToRoom,
  broadcast,
  hasActiveConnection,
  getActiveConnections,
  getUsersInRoom,
  sendTypingIndicator,
  sendTradeUpdate,
  sendUnreadUpdate,
  notifyUserStatusChange,
  sendSystemNotification,
};