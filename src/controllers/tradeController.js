const mongoose = require("mongoose");
const Item = require("../models/Item");
const Trade = require("../models/Trade");
const Conversation = require("../models/Conversation");

exports.createTradeRequest = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { offeredItem, requestedItem } = req.body;

    if (!offeredItem || !requestedItem || offeredItem === requestedItem) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Invalid trade request" });
    }

    const [offItem, reqItem] = await Promise.all([
      Item.findOne({
        _id: offeredItem,
        owner: req.user.id,
        status: "available",
      }).session(session),
      Item.findOne({
        _id: requestedItem,
        status: "available",
      }).session(session),
    ]);

    if (!offItem) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        message: "Offered item not found or not available",
      });
    }

    if (!reqItem) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        message: "Requested item not available",
      });
    }

    if (reqItem.owner.toString() === req.user.id) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Cannot request your own item" });
    }

    const existingTrade = await Trade.findOne({
      offeredItem,
      requestedItem,
      requester: req.user.id,
      status: { $in: ["proposed", "negotiating", "confirmed"] },
    }).session(session);

    if (existingTrade) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        message: "Active trade request already exists",
      });
    }

    const trade = await Trade.create(
      [
        {
          offeredItem,
          requestedItem,
          requester: req.user.id,
          owner: reqItem.owner,
          status: "proposed",
        },
      ],
      { session }
    );

    const conversation = await Conversation.create(
      [
        {
          participants: [req.user.id, reqItem.owner],
          trade: trade[0]._id,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    res.status(201).json({
      message: "Trade request created",
      trade: trade[0],
      conversationId: conversation[0]._id,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ message: error.message });
  }
};

exports.expressInterest = async (req, res) => {
  try {
    const trade = await Trade.findOneAndUpdate(
      {
        _id: req.params.id,
        owner: req.user.id,
        status: "proposed",
      },
      { status: "negotiating" },
      { new: true }
    )
      .populate("offeredItem", "title")
      .populate("requestedItem", "title");

    if (!trade) {
      return res.status(404).json({
        message: "Trade not found or not in proposed state",
      });
    }

    res.json({ message: "Interest expressed, trade is now negotiating", trade });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.confirmTrade = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const trade = await Trade.findOne({
      _id: req.params.id,
      owner: req.user.id,
      status: "negotiating",
    }).session(session);

    if (!trade) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        message: "Trade not found or not in negotiating state",
      });
    }

    const offeredItem = await Item.findOneAndUpdate(
      { _id: trade.offeredItem, status: "available" },
      { status: "traded" },
      { new: true, session }
    );

    const requestedItem = await Item.findOneAndUpdate(
      { _id: trade.requestedItem, status: "available" },
      { status: "traded" },
      { new: true, session }
    );

    if (!offeredItem || !requestedItem) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        message: "One or both items no longer available",
      });
    }

    trade.status = "confirmed";
    await trade.save({ session });

    await Trade.updateMany(
      {
        _id: { $ne: trade._id },
        status: { $in: ["proposed", "negotiating"] },
        $or: [
          { offeredItem: trade.offeredItem },
          { requestedItem: trade.requestedItem },
          { offeredItem: trade.requestedItem },
          { requestedItem: trade.offeredItem },
        ],
      },
      { status: "rejected" },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    res.json({ message: "Trade confirmed successfully", trade });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ message: error.message });
  }
};

exports.completeTrade = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const trade = await Trade.findOneAndUpdate(
      { _id: req.params.id, status: "confirmed" },
      { status: "completed", completedAt: new Date() },
      { new: true, session }
    );

    if (!trade) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        message: "Trade not found or not confirmed",
      });
    }

    if (
      trade.owner.toString() !== req.user.id &&
      trade.requester.toString() !== req.user.id
    ) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ message: "Not authorized" });
    }

    const offeredItem = await Item.findOne({
      _id: trade.offeredItem,
      status: "traded",
    }).session(session);

    const requestedItem = await Item.findOne({
      _id: trade.requestedItem,
      status: "traded",
    }).session(session);

    if (!offeredItem || !requestedItem) {
      await session.abortTransaction();
      session.endSession();
      return res.status(409).json({
        message: "Items not properly locked",
      });
    }

    const tempOwner = offeredItem.owner;
    offeredItem.owner = requestedItem.owner;
    requestedItem.owner = tempOwner;

    await offeredItem.save({ session });
    await requestedItem.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json({ message: "Trade completed successfully", trade });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ message: error.message });
  }
};

exports.rejectTrade = async (req, res) => {
  try {
    const trade = await Trade.findOneAndUpdate(
      {
        _id: req.params.id,
        owner: req.user.id,
        status: { $in: ["proposed", "negotiating"] },
      },
      { status: "rejected" },
      { new: true }
    );

    if (!trade) {
      return res.status(404).json({
        message: "Trade not found or cannot be rejected",
      });
    }

    res.json({ message: "Trade rejected", trade });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.myRequests = async (req, res) => {
  try {
    const trades = await Trade.find({ requester: req.user.id })
      .populate("offeredItem", "title status")
      .populate("requestedItem", "title status")
      .populate("owner", "name email")
      .sort({ createdAt: -1 });

    res.json(trades);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.requestForMe = async (req, res) => {
  try {
    const trades = await Trade.find({ owner: req.user.id })
      .populate("offeredItem", "title status")
      .populate("requestedItem", "title status")
      .populate("requester", "name email")
      .sort({ createdAt: -1 });

    res.json(trades);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};