const mongoose = require("mongoose");

const reactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  emoji: {
    type: String,
    required: true,
    enum: ["👍", "👎", "❤️", "😂", "😮", "😢", "🎉", "🔥"],
  },
}, { timestamps: true });

const attachmentSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["image", "file"],
    required: true,
  },
  url: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: true,
  },
  size: {
    type: Number,
    required: true,
    max: 10 * 1024 * 1024,
  },
  mimeType: {
    type: String,
    required: true,
  },
});

const messageSchema = new mongoose.Schema({
  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Conversation",
    required: true,
    index: true,
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  text: {
    type: String,
    trim: true,
    maxlength: 2000,
  },
  attachments: [attachmentSchema],
  reactions: [reactionSchema],
  readBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  }],
  replyTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Message",
  },
  isDeleted: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ "reactions.user": 1 });

messageSchema.pre("save", function(next) {
  if (!this.readBy.includes(this.sender)) {
    this.readBy.push(this.sender);
  }
  if (!this.text && (!this.attachments || this.attachments.length === 0)) {
    return next(new Error("Message must have text or attachments"));
  }
  next();
});

messageSchema.methods.addReaction = async function(userId, emoji) {
  const existingReaction = this.reactions.find(
    r => r.user.toString() === userId.toString()
  );
  
  if (existingReaction) {
    if (existingReaction.emoji === emoji) {
      await this.updateOne({ $pull: { reactions: { user: userId } } });
      return null;
    }
    await this.updateOne({
      $pull: { reactions: { user: userId } },
    });
  }
  
  await this.updateOne({
    $push: { reactions: { user: userId, emoji } },
  });
  
  return { user: userId, emoji };
};

messageSchema.methods.getReactionSummary = function() {
  const summary = {};
  this.reactions.forEach(r => {
    const key = r.emoji;
    if (!summary[key]) {
      summary[key] = { count: 0, users: [] };
    }
    summary[key].count++;
    summary[key].users.push(r.user);
  });
  return summary;
};

module.exports = mongoose.model("Message", messageSchema);
