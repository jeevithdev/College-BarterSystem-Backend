const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
  },
  resetPasswordToken: {
    type: String,
  },
  resetPasswordExpires: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  profileImage: {
    type: String,
  },
  isOnline: {
    type: Boolean,
    default: false,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
  },
  pushNotificationToken: {
    type: String,
  },
  notificationPreferences: {
    newMessage: { type: Boolean, default: true },
    tradeUpdate: { type: Boolean, default: true },
    tradeRequest: { type: Boolean, default: true },
  },
  unreadConversations: {
    type: Map,
    of: Number,
    default: {},
  },
}, { timestamps: true });

userSchema.methods.updateOnlineStatus = async function(isOnline) {
  this.isOnline = isOnline;
  this.lastSeen = new Date();
  await this.save();
};

module.exports = mongoose.model("User", userSchema);
