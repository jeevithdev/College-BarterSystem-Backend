const Item = require("../models/Item");
const Trade = require("../models/Trade");

exports.createTradeRequest = async (req, res) => {
  try {
    const { offeredItem, requestedItem } = req.body;

    if (!offeredItem || !requestedItem || offeredItem === requestedItem) {
      return res.status(400).json({ message: "Invalid trade request" });
    }

    const [reqItem, offItem] = await Promise.all([
      Item.findOne({ _id: requestedItem, status: "available" }),
      Item.findOne({ _id: offeredItem, owner: req.user.id, status: "available" }),
    ]);

    if (!reqItem || !offItem) {
      return res.status(404).json({ message: "Item not available for trade" });
    }

    if (reqItem.owner.toString() === req.user.id) {
      return res.status(400).json({ message: "Cannot request your own item" });
    }

    const existingTrade = await Trade.findOne({
      offeredItem,
      requestedItem,
      requester: req.user.id,
      status: "pending",
    });

    if (existingTrade) {
      return res.status(400).json({ message: "Trade request already exists" });
    }

    const trade = await Trade.create({
      offeredItem,
      requestedItem,
      requester: req.user.id,
      owner: reqItem.owner,
    });

    res.status(201).json({ message: "Trade request sent", trade });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.myRequests = async (req, res) => {
  try {
    const trades = await Trade.find({ requester: req.user.id })
      .populate("offeredItem", "title status")
      .populate("requestedItem", "title status")
      .populate("owner", "name");

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
      .populate("requester", "name");
    res.json(trades);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.tradeAccept = async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({ message: "Trade not found" });
    }

    if (trade.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }

    if (trade.status !== "pending") {
      return res.status(400).json({ message: "Trade already processed" });
    }
    const [offeredItem, requestedItem] = await Promise.all([
      Item.findOneAndUpdate(
        { _id: trade.offeredItem, status: "available" },
        { status: "traded" }
      ),
      Item.findOneAndUpdate(
        { _id: trade.requestedItem, status: "available" },
        { status: "traded" }
      ),
    ]);
    if (!offeredItem || !requestedItem) {
      return res.status(409).json({
        message: "One of the items is no longer available",
      });
    }

    trade.status = "accepted";
    await trade.save();

    await Trade.updateMany(
      {
        _id: { $ne: trade._id },
        status: "pending",

        $or: [
          { offeredItem: trade.offeredItem },
          { requestedItem: trade.requestedItem },
        ],
      },
      { status: "rejected" }
    );

    res.json({ message: "Trade accepted successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
exports.tradeReject = async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({ message: "Trade not found" });
    }

    if (trade.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }

    if (trade.status !== "pending") {
      return res.status(400).json({ message: "Trade already processed" });
    }

    trade.status = "rejected";
    await trade.save();

    res.json({ message: "Trade rejected" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
exports.completeTrade = async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({ message: "Trade not found" });
    }

    if (trade.status === "completed") {
      return res.status(400).json({ message: "Trade already completed" });
    }

    if (trade.status !== "accepted") {
      return res.status(400).json({ message: "Trade not ready to complete" });
    }
    if (
      trade.owner.toString() !== req.user.id &&
      trade.requester.toString() !== req.user.id
    ) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const [requestedItem, offeredItem] = await Promise.all([
      Item.findById(trade.requestedItem),
      Item.findById(trade.offeredItem),
    ]);
    if (!offeredItem || !requestedItem) {
      return res.status(404).json({ message: "Item not found" });
    }
    if (offeredItem.status !== "traded" || requestedItem.status !== "traded") {
      return res.status(409).json({ message: "Items not locked for trade" });
    }
    if (trade.owner.toString() === trade.requester.toString()) {
  return res.status(400).json({ message: "Invalid trade data" });
}


    const tempOwner = offeredItem.owner;
    offeredItem.owner = requestedItem.owner;
    requestedItem.owner = tempOwner;

    offeredItem.status = "available";
    requestedItem.status = "available";

    await Promise.all([offeredItem.save(), requestedItem.save()]);

    trade.status = "completed";
    trade.completedAt = new Date();
    await trade.save();

    res.json({ message: "Trade completed successfully" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
