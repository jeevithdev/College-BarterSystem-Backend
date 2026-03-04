const mongoose = require("mongoose");

const tradeSchema = new mongoose.Schema({
  offeredItem: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Item",
    required: true,
  },
  requestedItem: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Item",
    required: true,
  },
  requester: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  status: {
    type: String,
    enum: ["proposed", "accepted", "confirmed", "completed", "rejected", "expired"],
    default: "proposed",
  },
  // Track confirmation from both parties
  requesterConfirmed: {
    type: Boolean,
    default: false,
  },
  ownerConfirmed: {
    type: Boolean,
    default: false,
  },
  // Track completion from both parties
  requesterCompleted: {
    type: Boolean,
    default: false,
  },
  ownerCompleted: {
    type: Boolean,
    default: false,
  },
  confirmedAt: {
    type: Date,
  },
  completedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Trade", tradeSchema);
