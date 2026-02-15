const mongoose = require("mongoose");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");

exports.sendMessage = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { text } = req.body;
    const conversationId = req.params.id;

    if (!text || text.trim().length === 0) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Message text is required" });
    }

    const conversation = await Conversation.findById(conversationId).session(
      session
    );

    if (!conversation) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isParticipant = conversation.participants.some(
      (p) => p.toString() === req.user.id
    );

    if (!isParticipant) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({
        message: "Not authorized to send messages in this conversation",
      });
    }

    const message = await Message.create(
      [
        {
          conversation: conversationId,
          sender: req.user.id,
          text: text.trim(),
          readBy: [req.user.id],
        },
      ],
      { session }
    );

    conversation.lastMessage = message[0]._id;
    await conversation.save({ session });

    await session.commitTransaction();
    session.endSession();

    const populatedMessage = await Message.findById(message[0]._id).populate(
      "sender",
      "name email"
    );

    res.status(201).json({ message: "Message sent", data: populatedMessage });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ message: error.message });
  }
};

exports.getMessages = async (req, res) => {
  try {
    const conversationId = req.params.id;

    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isParticipant = conversation.participants.some(
      (p) => p.toString() === req.user.id
    );

    if (!isParticipant) {
      return res.status(403).json({
        message: "Not authorized to view this conversation",
      });
    }

    const messages = await Message.find({ conversation: conversationId })
      .populate("sender", "name email")
      .sort({ createdAt: 1 });

    res.json({ messages });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getConversation = async (req, res) => {
  try {
    const conversationId = req.params.id;

    const conversation = await Conversation.findById(conversationId)
      .populate("participants", "name email")
      .populate("trade")
      .populate({
        path: "lastMessage",
        populate: { path: "sender", select: "name email" },
      });

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isParticipant = conversation.participants.some(
      (p) => p._id.toString() === req.user.id
    );

    if (!isParticipant) {
      return res.status(403).json({
        message: "Not authorized to view this conversation",
      });
    }

    res.json({ conversation });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getUserConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user.id,
    })
      .populate("participants", "name email")
      .populate("trade", "status")
      .populate({
        path: "lastMessage",
        populate: { path: "sender", select: "name email" },
      })
      .sort({ updatedAt: -1 });

    res.json({ conversations });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const conversationId = req.params.id;

    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const isParticipant = conversation.participants.some(
      (p) => p.toString() === req.user.id
    );

    if (!isParticipant) {
      return res.status(403).json({
        message: "Not authorized",
      });
    }

    await Message.updateMany(
      {
        conversation: conversationId,
        readBy: { $ne: req.user.id },
      },
      { $addToSet: { readBy: req.user.id } }
    );

    res.json({ message: "Messages marked as read" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
