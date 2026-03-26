const mongoose = require("mongoose");
const Item = require("../models/Item");
const Trade = require("../models/Trade");
const { validationResult } = require("express-validator");
const { notifyTradeRequest, notifyTradeUpdate } = require("../utils/pushNotificationService");

// ─── Constants ────────────────────────────────────────────────────────
const TRADE_STATUS = {
  PROPOSED: "proposed",
  ACCEPTED: "accepted",
  CONFIRMED: "confirmed",
  COMPLETED: "completed",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
  EXPIRED: "expired",
};

const TRADE_EXPIRATION_DAYS = 7;

const ITEM_STATUS = {
  AVAILABLE: "available",
  TRADED: "traded",
};

// ─── Helper: validation ───────────────────────────────────────────────
const checkValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: "Validation failed", errors: errors.array() });
    return false;
  }
  return true;
};

// ─── Helper: safe session cleanup ─────────────────────────────────────
const cleanupSession = async (session) => {
  if (!session) return;
  try {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    await session.endSession();
  } catch (err) {
    console.error("Session cleanup error:", err.message);
  }
};

// ─── Auto-expire confirmed trades older than 7 days ───────────────────
const checkAndExpireTrades = async () => {
  try {
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() - TRADE_EXPIRATION_DAYS);

    const expiredTrades = await Trade.find({
      status: TRADE_STATUS.CONFIRMED,
      confirmedAt: { $lt: expirationDate },
    });

    if (expiredTrades.length === 0) return;

    for (const expiredTrade of expiredTrades) {
      let session;
      let completed = false;

      try {
        session = await mongoose.startSession();
        session.startTransaction();

        const trade = await Trade.findById(expiredTrade._id).session(session);
        if (!trade || trade.status !== TRADE_STATUS.CONFIRMED) {
          await session.abortTransaction();
          await session.endSession();
          completed = true;
          continue;
        }

        trade.status = TRADE_STATUS.EXPIRED;
        await trade.save({ session });

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

        console.log(`Trade ${trade._id} expired — items unlocked`);

        // Notify both parties
        notifyTradeUpdate(trade.requester, trade._id, "Your confirmed trade has expired. Items are available again.").catch(console.error);
        notifyTradeUpdate(trade.owner, trade._id, "A confirmed trade has expired. Items are available again.").catch(console.error);
      } catch (error) {
        if (!completed) await cleanupSession(session);
        console.error(`Error expiring trade ${expiredTrade._id}:`, error.message);
      }
    }
  } catch (error) {
    console.error("Error in checkAndExpireTrades:", error.message);
  }
};

// ─── Expiration Scheduler (called from server.js) ─────────────────────
let expirationInterval = null;
exports.startExpirationScheduler = () => {
  // Run immediately on startup, then every hour
  checkAndExpireTrades();
  expirationInterval = setInterval(checkAndExpireTrades, 60 * 60 * 1000);
  console.log("Trade expiration scheduler started (runs every hour)");
  return expirationInterval;
};

// ─── Create Trade Request ─────────────────────────────────────────────
exports.createTradeRequest = async (req, res) => {
  let session;
  let aborted = false;

  try {
    if (!checkValidation(req, res)) return;

    const { offeredItem, requestedItem } = req.body;

    if (offeredItem === requestedItem) {
      return res.status(400).json({ message: "Cannot trade an item for itself" });
    }

    session = await mongoose.startSession();
    session.startTransaction();

    const [offItemCheck, reqItemCheck] = await Promise.all([
      Item.findById(offeredItem).session(session),
      Item.findById(requestedItem).session(session),
    ]);

    if (!offItemCheck) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(404).json({ message: "Offered item not found" });
    }

    if (offItemCheck.owner.toString() !== req.user.id) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(403).json({ message: "You don't own the offered item" });
    }

    if (offItemCheck.status !== ITEM_STATUS.AVAILABLE) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(400).json({
        message: `Offered item is not available (status: ${offItemCheck.status})`,
      });
    }

    if (!reqItemCheck) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(404).json({ message: "Requested item not found" });
    }

    if (reqItemCheck.status !== ITEM_STATUS.AVAILABLE) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(400).json({
        message: `Requested item is not available (status: ${reqItemCheck.status})`,
      });
    }

    if (reqItemCheck.owner.toString() === req.user.id) {
      aborted = true;
      await session.abortTransaction();
      await session.endSession();
      return res.status(400).json({ message: "Cannot request your own item" });
    }

    // Check for existing active trade
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
      return res.status(400).json({ message: "Active trade request already exists" });
    }

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

    // Notify the item owner about the new trade request
    const User = require("../models/User");
    const requester = await User.findById(req.user.id).select("name");
    notifyTradeRequest(reqItemCheck.owner, trade._id, requester?.name || "Someone").catch(console.error);

    // Emit real-time event
    if (req.io) {
      req.io.to(`user:${reqItemCheck.owner}`).emit("tradeUpdate", {
        type: "new_request",
        trade,
      });
    }

    res.status(201).json({ message: "Trade request created", trade });
  } catch (error) {
    if (session && !aborted) await cleanupSession(session);
    res.status(500).json({ message: error.message });
  }
};

// ─── Accept Trade ─────────────────────────────────────────────────────
exports.acceptTrade = async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({ message: "Trade not found" });
    }

    if (trade.owner.toString() !== req.user.id) {
      return res.status(403).json({
        message: "Only the owner of the requested item can accept this trade",
      });
    }

    if (trade.status !== TRADE_STATUS.PROPOSED) {
      return res.status(400).json({
        message: `Trade cannot be accepted (current status: ${trade.status})`,
      });
    }

    trade.status = TRADE_STATUS.ACCEPTED;
    await trade.save();

    await trade.populate("offeredItem", "title");
    await trade.populate("requestedItem", "title");

    // Notify requester
    notifyTradeUpdate(trade.requester, trade._id, "Your trade request has been accepted! You can now chat.").catch(console.error);

    if (req.io) {
      req.io.to(`user:${trade.requester}`).emit("tradeUpdate", {
        type: "accepted",
        trade,
      });
    }

    res.json({ message: "Trade accepted, you can now chat with the requester", trade });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Confirm Trade (both parties must confirm) ────────────────────────
exports.confirmTrade = async (req, res) => {
  let session;
  let completed = false;

  try {
    session = await mongoose.startSession();
    await session.startTransaction();

    const checkTrade = await Trade.findOne({
      _id: req.params.id,
      status: TRADE_STATUS.ACCEPTED,
    }).session(session);

    if (!checkTrade) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(404).json({ message: "Trade not found or not in accepted state" });
    }

    const isRequester = checkTrade.requester.toString() === req.user.id;
    const isOwner = checkTrade.owner.toString() === req.user.id;

    if (!isRequester && !isOwner) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(403).json({ message: "You are not authorized to confirm this trade" });
    }

    const updateFields = {};
    if (isRequester) updateFields.requesterConfirmed = true;
    else if (isOwner) updateFields.ownerConfirmed = true;

    const updatedTrade = await Trade.findOneAndUpdate(
      { _id: req.params.id, status: TRADE_STATUS.ACCEPTED },
      { $set: updateFields },
      { new: true, session }
    );

    if (!updatedTrade) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(404).json({ message: "Trade not found or was already confirmed" });
    }

    // Check if both parties have confirmed
    if (updatedTrade.requesterConfirmed && updatedTrade.ownerConfirmed) {
      // Lock items atomically
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
        ),
      ]);

      // Race condition protection
      if (!offeredItem || !requestedItem) {
        await session.abortTransaction();
        await session.endSession();
        completed = true;
        return res.status(409).json({ message: "One or both items no longer available" });
      }

      // Update trade status and reject competing trades
      await Promise.all([
        Trade.updateOne(
          { _id: updatedTrade._id },
          { $set: { status: TRADE_STATUS.CONFIRMED, confirmedAt: new Date() } },
          { session }
        ),
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
        ),
      ]);

      await session.commitTransaction();
      await session.endSession();
      completed = true;

      const finalTrade = await Trade.findById(req.params.id);

      // Notify both parties
      const otherParty = isRequester ? updatedTrade.owner : updatedTrade.requester;
      notifyTradeUpdate(otherParty, finalTrade._id, "Trade confirmed! Both parties agreed. Items are now locked.").catch(console.error);

      if (req.io) {
        req.io.to(`user:${updatedTrade.requester}`).emit("tradeUpdate", { type: "confirmed", trade: finalTrade });
        req.io.to(`user:${updatedTrade.owner}`).emit("tradeUpdate", { type: "confirmed", trade: finalTrade });
      }

      return res.json({ message: "Trade confirmed! Both parties agreed. Items are now locked.", trade: finalTrade });
    } else {
      await session.commitTransaction();
      await session.endSession();
      completed = true;

      const waitingFor = isRequester ? "owner" : "requester";
      const otherParty = isRequester ? updatedTrade.owner : updatedTrade.requester;
      notifyTradeUpdate(otherParty, updatedTrade._id, "The other party has confirmed the trade. Your confirmation is needed.").catch(console.error);

      return res.json({
        message: `Your confirmation recorded. Waiting for ${waitingFor} to confirm.`,
        trade: updatedTrade,
      });
    }
  } catch (error) {
    if (!completed) await cleanupSession(session);
    res.status(500).json({ message: error.message });
  }
};

// ─── Complete Trade (both parties must mark complete) ──────────────────
exports.completeTrade = async (req, res) => {
  let session;
  let completed = false;

  try {
    session = await mongoose.startSession();
    await session.startTransaction();

    const checkTrade = await Trade.findOne({
      _id: req.params.id,
      status: TRADE_STATUS.CONFIRMED,
    }).session(session);

    if (!checkTrade) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(404).json({ message: "Trade not found or not in confirmed state" });
    }

    const isRequester = checkTrade.requester.toString() === req.user.id;
    const isOwner = checkTrade.owner.toString() === req.user.id;

    if (!isRequester && !isOwner) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(403).json({ message: "You are not authorized to complete this trade" });
    }

    const updateFields = {};
    if (isRequester) updateFields.requesterCompleted = true;
    else if (isOwner) updateFields.ownerCompleted = true;

    const updatedTrade = await Trade.findOneAndUpdate(
      { _id: req.params.id, status: TRADE_STATUS.CONFIRMED },
      { $set: updateFields },
      { new: true, session }
    );

    if (!updatedTrade) {
      await session.abortTransaction();
      await session.endSession();
      completed = true;
      return res.status(404).json({ message: "Trade not found or was already completed" });
    }

    if (updatedTrade.requesterCompleted && updatedTrade.ownerCompleted) {
      const [offeredItem, requestedItem] = await Promise.all([
        Item.findOne({ _id: updatedTrade.offeredItem, status: ITEM_STATUS.TRADED }).session(session),
        Item.findOne({ _id: updatedTrade.requestedItem, status: ITEM_STATUS.TRADED }).session(session),
      ]);

      if (!offeredItem || !requestedItem) {
        await session.abortTransaction();
        await session.endSession();
        completed = true;
        return res.status(409).json({ message: "Items not properly locked for trade" });
      }

      // SWAP OWNERSHIP atomically
      const tempOwner = offeredItem.owner;
      await Promise.all([
        Item.updateOne({ _id: offeredItem._id }, { $set: { owner: requestedItem.owner } }, { session }),
        Item.updateOne({ _id: requestedItem._id }, { $set: { owner: tempOwner } }, { session }),
      ]);

      await Trade.updateOne(
        { _id: updatedTrade._id },
        { $set: { status: TRADE_STATUS.COMPLETED, completedAt: new Date() } },
        { session }
      );

      await session.commitTransaction();
      await session.endSession();
      completed = true;

      const finalTrade = await Trade.findById(req.params.id);

      // Notify both parties
      notifyTradeUpdate(updatedTrade.requester, finalTrade._id, "Trade completed! Ownership has been swapped.").catch(console.error);
      notifyTradeUpdate(updatedTrade.owner, finalTrade._id, "Trade completed! Ownership has been swapped.").catch(console.error);

      if (req.io) {
        req.io.to(`user:${updatedTrade.requester}`).emit("tradeUpdate", { type: "completed", trade: finalTrade });
        req.io.to(`user:${updatedTrade.owner}`).emit("tradeUpdate", { type: "completed", trade: finalTrade });
      }

      return res.json({
        message: "Trade completed! Ownership has been swapped. Items remain as 'traded' — you can re-list them.",
        trade: finalTrade,
      });
    } else {
      await session.commitTransaction();
      await session.endSession();
      completed = true;

      const waitingFor = isRequester ? "owner" : "requester";
      const otherParty = isRequester ? updatedTrade.owner : updatedTrade.requester;
      notifyTradeUpdate(otherParty, updatedTrade._id, "The other party marked the trade as completed. Please confirm.").catch(console.error);

      return res.json({
        message: `Your completion recorded. Waiting for ${waitingFor} to mark as completed.`,
        trade: updatedTrade,
      });
    }
  } catch (error) {
    if (!completed) await cleanupSession(session);
    res.status(500).json({ message: error.message });
  }
};

// ─── Reject Trade ─────────────────────────────────────────────────────
exports.rejectTrade = async (req, res) => {
  try {
    const trade = await Trade.findOneAndUpdate(
      {
        _id: req.params.id,
        owner: req.user.id,
        status: { $in: [TRADE_STATUS.PROPOSED, TRADE_STATUS.ACCEPTED] },
      },
      { status: TRADE_STATUS.REJECTED },
      { new: true }
    );

    if (!trade) {
      return res.status(404).json({ message: "Trade not found or cannot be rejected" });
    }

    notifyTradeUpdate(trade.requester, trade._id, "Your trade request has been rejected.").catch(console.error);

    if (req.io) {
      req.io.to(`user:${trade.requester}`).emit("tradeUpdate", { type: "rejected", trade });
    }

    res.json({ message: "Trade rejected", trade });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Cancel/Withdraw Trade (by requester) ─────────────────────────────
exports.cancelTrade = async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({ message: "Trade not found" });
    }

    if (trade.requester.toString() !== req.user.id) {
      return res.status(403).json({ message: "Only the requester can withdraw this trade" });
    }

    if (trade.status !== TRADE_STATUS.PROPOSED) {
      return res.status(400).json({
        message: `Trade cannot be withdrawn (current status: ${trade.status}). Only proposed trades can be withdrawn.`,
      });
    }

    trade.status = TRADE_STATUS.WITHDRAWN;
    await trade.save();

    notifyTradeUpdate(trade.owner, trade._id, "A trade request has been withdrawn.").catch(console.error);

    if (req.io) {
      req.io.to(`user:${trade.owner}`).emit("tradeUpdate", { type: "withdrawn", trade });
    }

    res.json({ message: "Trade request withdrawn successfully", trade });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── My Requests (paginated + filterable) ─────────────────────────────
exports.myRequests = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const filter = { requester: req.user.id };

    // Optional status filter
    if (req.query.status) {
      const statuses = req.query.status.split(",").map((s) => s.trim());
      filter.status = { $in: statuses };
    }

    const totalCount = await Trade.countDocuments(filter);

    const trades = await Trade.find(filter)
      .populate("offeredItem", "title status images")
      .populate("requestedItem", "title status images")
      .populate("owner", "name email profileImage")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      hasMore: page < Math.ceil(totalCount / limit),
      trades,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Requests For Me (paginated + filterable) ─────────────────────────
exports.requestsForMe = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const filter = { owner: req.user.id };

    if (req.query.status) {
      const statuses = req.query.status.split(",").map((s) => s.trim());
      filter.status = { $in: statuses };
    }

    const totalCount = await Trade.countDocuments(filter);

    const trades = await Trade.find(filter)
      .populate("offeredItem", "title status images")
      .populate("requestedItem", "title status images")
      .populate("requester", "name email profileImage")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      hasMore: page < Math.ceil(totalCount / limit),
      trades,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── Manual Expiration Check ──────────────────────────────────────────
exports.checkExpiredTrades = async (req, res) => {
  try {
    await checkAndExpireTrades();
    res.json({ message: "Expiration check completed" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};