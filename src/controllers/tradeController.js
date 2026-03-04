const mongoose = require("mongoose");
const Item = require("../models/Item");
const Trade = require("../models/Trade");

// Constants for better code readability and maintainability
const TRADE_STATUS = {
  PROPOSED: "proposed",
  ACCEPTED: "accepted",
  CONFIRMED: "confirmed",
  COMPLETED: "completed",
  REJECTED: "rejected",
  EXPIRED: "expired",
};

// Trade expiration: 7 days after confirmation
const TRADE_EXPIRATION_DAYS = 7;

const ITEM_STATUS = {
  AVAILABLE: "available",
  TRADED: "traded",
};

// Helper function to automatically expire trades older than 7 days
// This unlocks items and makes them available again
const checkAndExpireTrades = async () => {
  try {
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() - TRADE_EXPIRATION_DAYS);

    // Find all confirmed trades older than 7 days
    const expiredTrades = await Trade.find({
      status: TRADE_STATUS.CONFIRMED,
      confirmedAt: { $lt: expirationDate }, // Less than 7 days ago
    });

    if (expiredTrades.length === 0) {
      return; // No expired trades
    }

    // Process each expired trade
    for (const trade of expiredTrades) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Update trade status to expired
        trade.status = TRADE_STATUS.EXPIRED;
        await trade.save({ session });

        // Unlock the items - make them available again
        await Item.updateOne(
          { _id: trade.offeredItem },
          { status: ITEM_STATUS.AVAILABLE },
          { session }
        );

        await Item.updateOne(
          { _id: trade.requestedItem },
          { status: ITEM_STATUS.AVAILABLE },
          { session }
        );

        await session.commitTransaction();
        session.endSession();

        console.log(`Trade ${trade._id} expired and items unlocked`);
      } catch (error) {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        session.endSession();
        console.error(`Error expiring trade ${trade._id}:`, error.message);
      }
    }
  } catch (error) {
    console.error("Error in checkAndExpireTrades:", error.message);
  }
};

exports.createTradeRequest = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { offeredItem, requestedItem } = req.body;

    // Validation: Check if both items are provided and different
    if (!offeredItem || !requestedItem || offeredItem === requestedItem) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Invalid trade request" });
    }

    // Fetch both items in parallel for efficiency
    const [offItem, reqItem] = await Promise.all([
      Item.findOne({
        _id: offeredItem,
        owner: req.user.id,
        status: ITEM_STATUS.AVAILABLE,
      }).session(session),
      Item.findOne({
        _id: requestedItem,
        status: ITEM_STATUS.AVAILABLE,
      }).session(session),
    ]);

    // Check if offered item exists and belongs to requester
    if (!offItem) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        message: "Offered item not found or not available",
      });
    }

    // Check if requested item is available
    if (!reqItem) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        message: "Requested item not available",
      });
    }

    // Prevent trading with yourself
    if (reqItem.owner.toString() === req.user.id) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "Cannot request your own item" });
    }

    // Check if there's already an active trade request
    // Active means: proposed, accepted, or confirmed
    const existingTrade = await Trade.findOne({
      offeredItem,
      requestedItem,
      requester: req.user.id,
      status: { $in: [TRADE_STATUS.PROPOSED, TRADE_STATUS.ACCEPTED, TRADE_STATUS.CONFIRMED] },
    }).session(session);

    if (existingTrade) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        message: "Active trade request already exists",
      });
    }

    // Create the trade request
    const trade = await Trade.create(
      [
        {
          offeredItem,
          requestedItem,
          requester: req.user.id,
          owner: reqItem.owner,
          status: TRADE_STATUS.PROPOSED,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    res.status(201).json({
      message: "Trade request created",
      trade: trade[0],
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    res.status(500).json({ message: error.message });
  }
};

// User B (item owner) accepts the trade proposal
// This enables conversation between both parties
exports.acceptTrade = async (req, res) => {
  try {
    const trade = await Trade.findOneAndUpdate(
      {
        _id: req.params.id,
        owner: req.user.id, // Only the item owner can accept
        status: TRADE_STATUS.PROPOSED, // Can only accept if still proposed
      },
      { status: TRADE_STATUS.ACCEPTED },
      { new: true }
    )
      .populate("offeredItem", "title")
      .populate("requestedItem", "title");

    if (!trade) {
      return res.status(404).json({
        message: "Trade not found or not in proposed state",
      });
    }

    res.json({ 
      message: "Trade accepted, you can now chat with the requester", 
      trade 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Both parties must confirm the trade
// When both confirm: items get locked and other trades get rejected
exports.confirmTrade = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Find the trade that needs to be confirmed
    const trade = await Trade.findOne({
      _id: req.params.id,
      status: TRADE_STATUS.ACCEPTED, // Can only confirm after acceptance
    }).session(session);

    if (!trade) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        message: "Trade not found or not in accepted state",
      });
    }

    // Check if user is part of this trade
    const isRequester = trade.requester.toString() === req.user.id;
    const isOwner = trade.owner.toString() === req.user.id;

    if (!isRequester && !isOwner) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ 
        message: "You are not authorized to confirm this trade" 
      });
    }

    // Set the confirmation flag for the current user
    if (isRequester) {
      trade.requesterConfirmed = true;
    } else if (isOwner) {
      trade.ownerConfirmed = true;
    }

    // Check if both parties have confirmed
    if (trade.requesterConfirmed && trade.ownerConfirmed) {
      // Both confirmed! Lock the items
      const offeredItem = await Item.findOneAndUpdate(
        { _id: trade.offeredItem, status: ITEM_STATUS.AVAILABLE },
        { status: ITEM_STATUS.TRADED },
        { new: true, session }
      );

      const requestedItem = await Item.findOneAndUpdate(
        { _id: trade.requestedItem, status: ITEM_STATUS.AVAILABLE },
        { status: ITEM_STATUS.TRADED },
        { new: true, session }
      );

      // Check if items are still available (race condition protection)
      if (!offeredItem || !requestedItem) {
        await session.abortTransaction();
        session.endSession();
        return res.status(409).json({
          message: "One or both items no longer available",
        });
      }

      // Update trade status to confirmed
      trade.status = TRADE_STATUS.CONFIRMED;
      trade.confirmedAt = new Date(); // Track when confirmed for expiration
      
      // Reject all other trades involving these two items
      await Trade.updateMany(
        {
          _id: { $ne: trade._id }, // Not this trade
          status: { $in: [TRADE_STATUS.PROPOSED, TRADE_STATUS.ACCEPTED] }, // Only active trades
          $or: [
            { offeredItem: trade.offeredItem },
            { requestedItem: trade.requestedItem },
            { offeredItem: trade.requestedItem },
            { requestedItem: trade.offeredItem },
          ],
        },
        { status: TRADE_STATUS.REJECTED },
        { session }
      );

      await trade.save({ session });
      await session.commitTransaction();
      session.endSession();

      return res.json({ 
        message: "Trade confirmed! Both parties agreed. Items are now locked.", 
        trade 
      });
    } else {
      // Only one party confirmed so far
      await trade.save({ session });
      await session.commitTransaction();
      session.endSession();

      const waitingFor = isRequester ? "owner" : "requester";
      return res.json({ 
        message: `Your confirmation recorded. Waiting for ${waitingFor} to confirm.`, 
        trade 
      });
    }
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    res.status(500).json({ message: error.message });
  }
};

// Both parties must mark the trade as completed
// When both complete: ownership swaps, items stay "traded"
exports.completeTrade = async (req, res) => {
  // Check and expire old trades before processing
  await checkAndExpireTrades();

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Find the trade that needs to be completed
    const trade = await Trade.findOne({
      _id: req.params.id,
      status: TRADE_STATUS.CONFIRMED, // Can only complete if confirmed
    }).session(session);

    if (!trade) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        message: "Trade not found or not in confirmed state",
      });
    }

    // Authorization: Check if user is part of this trade
    const isRequester = trade.requester.toString() === req.user.id;
    const isOwner = trade.owner.toString() === req.user.id;

    if (!isRequester && !isOwner) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ 
        message: "You are not authorized to complete this trade" 
      });
    }

    // Set the completion flag for the current user
    if (isRequester) {
      trade.requesterCompleted = true;
    } else if (isOwner) {
      trade.ownerCompleted = true;
    }

    // Check if both parties have marked as completed
    if (trade.requesterCompleted && trade.ownerCompleted) {
      // Both completed! Fetch the items
      const offeredItem = await Item.findOne({
        _id: trade.offeredItem,
        status: ITEM_STATUS.TRADED,
      }).session(session);

      const requestedItem = await Item.findOne({
        _id: trade.requestedItem,
        status: ITEM_STATUS.TRADED,
      }).session(session);

      // Verify items are properly locked
      if (!offeredItem || !requestedItem) {
        await session.abortTransaction();
        session.endSession();
        return res.status(409).json({
          message: "Items not properly locked for trade",
        });
      }

      // SWAP OWNERSHIP
      // Important: We swap the owners but keep status as "traded"
      // New owners must manually re-list if they want to trade again
      const tempOwner = offeredItem.owner;
      offeredItem.owner = requestedItem.owner;
      requestedItem.owner = tempOwner;

      // Save the items with new ownership
      await offeredItem.save({ session });
      await requestedItem.save({ session });

      // Update trade status and completion timestamp
      trade.status = TRADE_STATUS.COMPLETED;
      trade.completedAt = new Date();
      await trade.save({ session });

      await session.commitTransaction();
      session.endSession();

      return res.json({ 
        message: "Trade completed successfully! Ownership has been swapped. Items remain as 'traded' - you can re-list them if desired.", 
        trade 
      });
    } else {
      // Only one party marked as completed
      await trade.save({ session });
      await session.commitTransaction();
      session.endSession();

      const waitingFor = isRequester ? "owner" : "requester";
      return res.json({ 
        message: `Your completion recorded. Waiting for ${waitingFor} to mark as completed.`, 
        trade 
      });
    }
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    res.status(500).json({ message: error.message });
  }
};

// Owner can reject a trade at proposed or accepted stage
exports.rejectTrade = async (req, res) => {
  try {
    const trade = await Trade.findOneAndUpdate(
      {
        _id: req.params.id,
        owner: req.user.id, // Only owner can reject
        status: { $in: [TRADE_STATUS.PROPOSED, TRADE_STATUS.ACCEPTED] }, // Can reject before confirmation
      },
      { status: TRADE_STATUS.REJECTED },
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

// Get all trade requests made by the current user
exports.myRequests = async (req, res) => {
  try {
    // Check and expire old trades before fetching
    await checkAndExpireTrades();

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

// Manual endpoint to trigger expiration check
// Useful for testing or cron jobs
exports.checkExpiredTrades = async (req, res) => {
  try {
    await checkAndExpireTrades();
    res.json({ 
      message: "Expiration check completed. Trades older than 7 days have been expired and items unlocked." 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all trade requests received by the current user
exports.requestsForMe = async (req, res) => {
  try {
    // Check and expire old trades before fetching
    await checkAndExpireTrades();

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