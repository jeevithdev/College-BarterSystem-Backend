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
  WITHDRAWN: "withdrawn",
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

    // Process each expired trade with its own isolated session
    for (const expiredTrade of expiredTrades) {
      let session;
      let completed = false;
      
      try {
        session = await mongoose.startSession();
        session.startTransaction();

        // Re-fetch the trade within the session to ensure consistency
        const trade = await Trade.findById(expiredTrade._id).session(session);
        
        if (!trade || trade.status !== TRADE_STATUS.CONFIRMED) {
          // Trade was already processed or status changed
          await session.abortTransaction();
          await session.endSession();
          completed = true;
          continue;
        }

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
        await session.endSession();
        completed = true;

        console.log(`Trade ${trade._id} expired and items unlocked`);
      } catch (error) {
        if (session && !completed) {
          try {
            if (session.inTransaction()) {
              await session.abortTransaction();
            }
            await session.endSession();
          } catch (cleanupError) {
            console.error("Session cleanup error:", cleanupError.message);
          }
        }
        console.error(`Error expiring trade ${expiredTrade._id}:`, error.message);
      }
    }
  } catch (error) {
    console.error("Error in checkAndExpireTrades:", error.message);
  }
};

exports.createTradeRequest = async (req, res) => {
  let session;
  let aborted = false;
  
  try {
    const { offeredItem, requestedItem } = req.body;

    // Validation: Check if both items are provided and different
    if (!offeredItem || !requestedItem || offeredItem === requestedItem) {
      return res.status(400).json({ message: "Invalid trade request" });
    }

    session = await mongoose.startSession();
    session.startTransaction();

    // Fetch both items - first check if they exist at all
    const [offItemCheck, reqItemCheck] = await Promise.all([
      Item.findById(offeredItem).session(session),
      Item.findById(requestedItem).session(session),
    ]);

    // Check if offered item exists
    if (!offItemCheck) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(404).json({
        message: "Offered item not found",
      });
    }

    // Check if offered item belongs to requester
    if (offItemCheck.owner.toString() !== req.user.id) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(403).json({
        message: "You don't own the offered item",
        debug: {
          itemOwner: offItemCheck.owner.toString(),
          yourId: req.user.id,
        }
      });
    }

    // Check if offered item is available
    if (offItemCheck.status !== ITEM_STATUS.AVAILABLE) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(400).json({
        message: `Offered item is not available. Current status: ${offItemCheck.status}`,
      });
    }

    // Check if requested item exists
    if (!reqItemCheck) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(404).json({
        message: "Requested item not found",
      });
    }

    // Check if requested item is available
    if (reqItemCheck.status !== ITEM_STATUS.AVAILABLE) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(400).json({
        message: `Requested item is not available. Current status: ${reqItemCheck.status}`,
      });
    }

    // Prevent trading with yourself
    if (reqItemCheck.owner.toString() === req.user.id) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
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
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(400).json({
        message: "Active trade request already exists",
      });
    }

    // Create the trade request
    const trade = new Trade({
      offeredItem,
      requestedItem,
      requester: req.user.id,
      owner: reqItemCheck.owner,
      status: TRADE_STATUS.PROPOSED,
    });
    await trade.save({ session });

    await session.commitTransaction();
    await session.endSession();

    res.status(201).json({
      message: "Trade request created",
      trade,
    });
  } catch (error) {
    if (session && !aborted) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        await session.endSession();
      } catch (cleanupError) {
        console.error("Session cleanup error:", cleanupError.message);
      }
    }
    res.status(500).json({ message: error.message });
  }
};

// User B (item owner) accepts the trade proposal
// This enables conversation between both parties
exports.acceptTrade = async (req, res) => {
  try {
    // First, find the trade to provide better error messages
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({
        message: "Trade not found",
      });
    }

    // Check if user is the owner (owner of the requested item)
    if (trade.owner.toString() !== req.user.id) {
      return res.status(403).json({
        message: "Only the owner of the requested item can accept this trade",
        debug: {
          tradeOwner: trade.owner.toString(),
          currentUser: req.user.id,
        }
      });
    }

    // Check if trade is in proposed state
    if (trade.status !== TRADE_STATUS.PROPOSED) {
      return res.status(400).json({
        message: `Trade cannot be accepted. Current status: ${trade.status}`,
      });
    }

    // Update the trade
    trade.status = TRADE_STATUS.ACCEPTED;
    await trade.save();

    // Populate for response
    await trade.populate("offeredItem", "title");
    await trade.populate("requestedItem", "title");

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
  let session;
  let completed = false;
  
  try {
    session = await mongoose.startSession();
    await session.startTransaction();

    // First check authorization - fetch the trade
    const checkTrade = await Trade.findOne({
      _id: req.params.id,
      status: TRADE_STATUS.ACCEPTED,
    }).session(session);

    if (!checkTrade) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(404).json({
        message: "Trade not found or not in accepted state",
      });
    }

    // Check if user is part of this trade
    const isRequester = checkTrade.requester.toString() === req.user.id;
    const isOwner = checkTrade.owner.toString() === req.user.id;

    if (!isRequester && !isOwner) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(403).json({ 
        message: "You are not authorized to confirm this trade" 
      });
    }

    // Set the appropriate confirmation flag using atomic update
    const updateFields = {};
    if (isRequester) {
      updateFields.requesterConfirmed = true;
    } else if (isOwner) {
      updateFields.ownerConfirmed = true;
    }

    // Update the trade atomically
    const updatedTrade = await Trade.findOneAndUpdate(
      { 
        _id: req.params.id,
        status: TRADE_STATUS.ACCEPTED 
      },
      { $set: updateFields },
      { 
        new: true,
        session 
      }
    );

    if (!updatedTrade) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(404).json({
        message: "Trade not found or was already confirmed",
      });
    }

    // Check if both parties have confirmed
    if (updatedTrade.requesterConfirmed && updatedTrade.ownerConfirmed) {
      // Both confirmed! Lock the items atomically
      const [offeredItem, requestedItem] = await Promise.all([
        Item.findOneAndUpdate(
          { _id: updatedTrade.offeredItem, status: ITEM_STATUS.AVAILABLE },
          { $set: { status: ITEM_STATUS.TRADED } },
          { new: true, session }
        ),
        Item.findOneAndUpdate(
          { _id: updatedTrade.requestedItem, status: ITEM_STATUS.AVAILABLE },
          { $set: { status: ITEM_STATUS.TRADED } },
          { new: true, session }
        )
      ]);

      // Check if items are still available (race condition protection)
      if (!offeredItem || !requestedItem) {
        await session.abortTransaction();
        await session.endSession();
        completed = true;
        return res.status(409).json({
          message: "One or both items no longer available",
        });
      }

      // Update trade status to confirmed and reject other trades
      await Promise.all([
        Trade.updateOne(
          { _id: updatedTrade._id },
          { 
            $set: { 
              status: TRADE_STATUS.CONFIRMED,
              confirmedAt: new Date()
            }
          },
          { session }
        ),
        // Reject all other trades involving these two items
        Trade.updateMany(
          {
            _id: { $ne: updatedTrade._id },
            status: { $in: [TRADE_STATUS.PROPOSED, TRADE_STATUS.ACCEPTED] },
            $or: [
              { offeredItem: updatedTrade.offeredItem },
              { requestedItem: updatedTrade.requestedItem },
              { offeredItem: updatedTrade.requestedItem },
              { requestedItem: updatedTrade.offeredItem },
            ],
          },
          { $set: { status: TRADE_STATUS.REJECTED } },
          { session }
        )
      ]);

      await session.commitTransaction();
      await session.endSession();
      completed = true;

      // Fetch the final trade state without session
      const finalTrade = await Trade.findById(req.params.id);

      return res.json({ 
        message: "Trade confirmed! Both parties agreed. Items are now locked.", 
        trade: finalTrade 
      });
    } else {
      // Only one party confirmed so far
      await session.commitTransaction();
      await session.endSession();
      completed = true;

      const waitingFor = isRequester ? "owner" : "requester";
      return res.json({ 
        message: `Your confirmation recorded. Waiting for ${waitingFor} to confirm.`, 
        trade: updatedTrade 
      });
    }
  } catch (error) {
    if (session && !completed) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        await session.endSession();
      } catch (cleanupError) {
        console.error("Session cleanup error:", cleanupError.message);
      }
    }
    res.status(500).json({ message: error.message });
  }
};

// Both parties must mark the trade as completed
// When both complete: ownership swaps, items stay "traded"
exports.completeTrade = async (req, res) => {
  let session;
  let completed = false;
  
  try {
    session = await mongoose.startSession();
    await session.startTransaction();

    // Find the trade that needs to be completed - use findOneAndUpdate for atomicity
    // This approach is more atomic and prevents race conditions
    const updateFields = {};
    
    // First check if user is authorized by fetching the trade
    const checkTrade = await Trade.findOne({
      _id: req.params.id,
      status: TRADE_STATUS.CONFIRMED,
    }).session(session);

    if (!checkTrade) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(404).json({
        message: "Trade not found or not in confirmed state",
      });
    }

    // Check if user is part of this trade
    const isRequester = checkTrade.requester.toString() === req.user.id;
    const isOwner = checkTrade.owner.toString() === req.user.id;

    if (!isRequester && !isOwner) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(403).json({ 
        message: "You are not authorized to complete this trade" 
      });
    }

    // Set the appropriate completion flag
    if (isRequester) {
      updateFields.requesterCompleted = true;
    } else if (isOwner) {
      updateFields.ownerCompleted = true;
    }

    // Update the trade atomically
    const updatedTrade = await Trade.findOneAndUpdate(
      { 
        _id: req.params.id,
        status: TRADE_STATUS.CONFIRMED 
      },
      { $set: updateFields },
      { 
        new: true,
        session 
      }
    );

    if (!updatedTrade) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(404).json({
        message: "Trade not found or was already completed",
      });
    }

    // Check if both parties have marked as completed
    if (updatedTrade.requesterCompleted && updatedTrade.ownerCompleted) {
      // Both completed! Fetch the items within the session
      const [offeredItem, requestedItem] = await Promise.all([
        Item.findOne({
          _id: updatedTrade.offeredItem,
          status: ITEM_STATUS.TRADED,
        }).session(session),
        Item.findOne({
          _id: updatedTrade.requestedItem,
          status: ITEM_STATUS.TRADED,
        }).session(session)
      ]);

      // Verify items are properly locked
      if (!offeredItem || !requestedItem) {
        await session.abortTransaction();
        await session.endSession();
        completed = true;
        return res.status(409).json({
          message: "Items not properly locked for trade",
        });
      }

      // SWAP OWNERSHIP using atomic updates
      const tempOwner = offeredItem.owner;
      
      await Promise.all([
        Item.updateOne(
          { _id: offeredItem._id },
          { $set: { owner: requestedItem.owner } },
          { session }
        ),
        Item.updateOne(
          { _id: requestedItem._id },
          { $set: { owner: tempOwner } },
          { session }
        )
      ]);

      // Update trade status to completed
      await Trade.updateOne(
        { _id: updatedTrade._id },
        { 
          $set: { 
            status: TRADE_STATUS.COMPLETED,
            completedAt: new Date()
          }
        },
        { session }
      );

      await session.commitTransaction();
      await session.endSession();
      completed = true;

      // Fetch the final trade state without session
      const finalTrade = await Trade.findById(req.params.id);

      return res.json({ 
        message: "Trade completed successfully! Ownership has been swapped. Items remain as 'traded' - you can re-list them if desired.", 
        trade: finalTrade 
      });
    } else {
      // Only one party marked as completed
      await session.commitTransaction();
      await session.endSession();
      completed = true;

      const waitingFor = isRequester ? "owner" : "requester";
      return res.json({ 
        message: `Your completion recorded. Waiting for ${waitingFor} to mark as completed.`, 
        trade: updatedTrade 
      });
    }
  } catch (error) {
    if (session && !completed) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
        await session.endSession();
      } catch (cleanupError) {
        console.error("Session cleanup error:", cleanupError.message);
      }
    }
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

// Requester can cancel/withdraw their trade request at proposed stage
exports.cancelTrade = async (req, res) => {
  try {
    // First, find the trade to provide better error messages
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({
        message: "Trade not found",
      });
    }

    // Check if user is the requester (person who initiated the trade)
    if (trade.requester.toString() !== req.user.id) {
      return res.status(403).json({
        message: "Only the requester can withdraw this trade",
        debug: {
          tradeRequester: trade.requester.toString(),
          currentUser: req.user.id,
        }
      });
    }

    // Check if trade is in proposed state (only proposed trades can be withdrawn)
    if (trade.status !== TRADE_STATUS.PROPOSED) {
      return res.status(400).json({
        message: `Trade cannot be withdrawn. Current status: ${trade.status}. Only proposed trades can be withdrawn.`,
      });
    }

    // Update the trade status to withdrawn
    trade.status = TRADE_STATUS.WITHDRAWN;
    await trade.save();

    res.json({ 
      message: "Trade request withdrawn successfully", 
      trade 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get all trade requests made by the current user
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