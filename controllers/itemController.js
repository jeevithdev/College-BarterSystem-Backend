const Item = require("../models/Item");
exports.createItem = async (req, res) => {
  try {
    const { title, description, category, condition, lookingFor, images } = req.body;
    if (!title || !description || !category || !condition || !lookingFor) {
      return res.status(400).json({ message: "All required fields must be provided" });
    }

    const item = new Item({
      title,
      description,
      category,
      condition,
      lookingFor,
      images: images || [],
      owner: req.user.id,
    });

    await item.save();

    return res.status(201).json({
      message: "Item created successfully",
      item,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
exports.getItems = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = 10;
    const skip = (page - 1) * limit;

    const filter = { status: "available" };

    if (req.query.category) {
      filter.category = req.query.category;
    }

    if (req.query.condition) {
      filter.condition = req.query.condition;
    }

    if (req.query.search) {
      filter.title = { $regex: req.query.search, $options: "i" };
    }

    const items = await Item.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)
      .populate("owner", "name");

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

    return res.json({
      page,
      limit,
      hasMore,
      items,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
exports.getItemDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const item = await Item.findById(id).populate(
      "owner",
      "name rating isVerified profileImage createdAt"
    );

    if (!item || item.status !== "available") {
      return res.status(404).json({ message: "Item not found" });
    }

    const relatedItems = await Item.find({
      category: item.category,
      status: "available",
      _id: { $ne: item._id },
    })
      .sort({ createdAt: -1 })
      .limit(4)
      .populate("owner", "name");

    return res.json({
      item,
      relatedItems,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
exports.getMyItems = async (req, res) => {
  try {
    const items = await Item.find({ owner: req.user.id })
      .sort({ createdAt: -1 });

    return res.json(items);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
exports.deleteItem = async (req, res) => {
  try {
    const item = await Item.findOne({
      _id: req.params.id,
      owner: req.user.id,
    });

    if (!item) {
      return res.status(404).json({ message: "Item not found or not authorized" });
    }

    await item.deleteOne();

    return res.json({ message: "Item deleted successfully" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
