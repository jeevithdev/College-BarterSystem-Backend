const Item = require("../models/Item");
const { validationResult } = require("express-validator");
const { escapeRegex } = require("../utils/helpers");

// ─── Helper: extract validation errors ────────────────────────────────
const checkValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ message: "Validation failed", errors: errors.array() });
    return false;
  }
  return true;
};

// ─── Create Item ──────────────────────────────────────────────────────
exports.createItem = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { title, description, category, condition, lookingFor, images } = req.body;

    // Check for duplicate item (same title and owner) — escaped regex
    const existingItem = await Item.findOne({
      title: { $regex: `^${escapeRegex(title.trim())}$`, $options: "i" },
      owner: req.user.id,
      status: "available",
    });

    if (existingItem) {
      return res.status(409).json({ message: "You already have an available item with this title" });
    }

    const item = new Item({
      title: title.trim(),
      description: description.trim(),
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

// ─── Get Items (paginated with filters) ───────────────────────────────
exports.getItems = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;

    const filter = { status: "available" };

    // Category filter (single or multiple)
    if (req.query.category) {
      const categories = req.query.category.split(",").map((c) => c.trim());
      filter.category = { $in: categories };
    }

    // Condition filter (single or multiple)
    if (req.query.condition) {
      const conditions = req.query.condition.split(",").map((c) => c.trim());
      filter.condition = { $in: conditions };
    }

    // Looking for filter
    if (req.query.lookingFor) {
      const lookingForOptions = req.query.lookingFor.split(",").map((l) => l.trim());
      filter.lookingFor = { $in: lookingForOptions };
    }

    // Search in title and description — ESCAPED to prevent ReDoS
    if (req.query.search) {
      const escapedSearch = escapeRegex(req.query.search);
      filter.$or = [
        { title: { $regex: escapedSearch, $options: "i" } },
        { description: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    // Exclude current user's items (useful when browsing for trades)
    if (req.query.excludeOwn === "true" && req.user) {
      filter.owner = { $ne: req.user.id };
    }

    // Filter by specific owner
    if (req.query.owner) {
      filter.owner = req.query.owner;
    }

    // Sorting options
    let sortOption = { createdAt: -1 }; // Default: newest first
    if (req.query.sort) {
      switch (req.query.sort) {
        case "oldest":
          sortOption = { createdAt: 1 };
          break;
        case "title_asc":
          sortOption = { title: 1 };
          break;
        case "title_desc":
          sortOption = { title: -1 };
          break;
        case "newest":
        default:
          sortOption = { createdAt: -1 };
      }
    }

    const totalCount = await Item.countDocuments(filter);

    const items = await Item.find(filter)
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .populate("owner", "name email profileImage");

    const totalPages = Math.ceil(totalCount / limit);
    const hasMore = page < totalPages;

    return res.json({
      page,
      limit,
      totalCount,
      totalPages,
      hasMore,
      items,
      filters: {
        category: req.query.category || null,
        condition: req.query.condition || null,
        lookingFor: req.query.lookingFor || null,
        search: req.query.search || null,
        sort: req.query.sort || "newest",
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Get Item Details ─────────────────────────────────────────────────
exports.getItemDetails = async (req, res) => {
  try {
    const { id } = req.params;

    // Fixed: removed non-existent fields 'rating' and 'isVerified' from populate
    const item = await Item.findById(id).populate(
      "owner",
      "name profileImage createdAt isOnline lastSeen"
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
      .populate("owner", "name profileImage");

    return res.json({
      item,
      relatedItems,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Get My Items ─────────────────────────────────────────────────────
exports.getMyItems = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const skip = (page - 1) * limit;

    const filter = { owner: req.user.id };

    // Optional status filter
    if (req.query.status) {
      filter.status = req.query.status;
    }

    const totalCount = await Item.countDocuments(filter);
    const items = await Item.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);

    return res.json({
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      hasMore: page < Math.ceil(totalCount / limit),
      items,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Edit Item ────────────────────────────────────────────────────────
exports.editItem = async (req, res) => {
  try {
    if (!checkValidation(req, res)) return;

    const { title, description, category, condition, lookingFor, images } = req.body;

    const item = await Item.findOne({
      _id: req.params.id,
      owner: req.user.id,
      status: "available",
    });

    if (!item) {
      return res.status(404).json({ message: "Item not found, not authorized, or already traded" });
    }

    // Check for duplicate title if title is being updated — escaped regex
    if (title && title.trim() !== item.title) {
      const duplicateItem = await Item.findOne({
        title: { $regex: `^${escapeRegex(title.trim())}$`, $options: "i" },
        owner: req.user.id,
        status: "available",
        _id: { $ne: req.params.id },
      });

      if (duplicateItem) {
        return res.status(409).json({ message: "You already have another available item with this title" });
      }
    }

    // Update only the fields that are provided
    if (title !== undefined) item.title = title.trim();
    if (description !== undefined) item.description = description.trim();
    if (category !== undefined) item.category = category;
    if (condition !== undefined) item.condition = condition;
    if (lookingFor !== undefined) item.lookingFor = lookingFor;
    if (images !== undefined) item.images = images;

    await item.save();

    return res.json({
      message: "Item updated successfully",
      item,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Delete Item ──────────────────────────────────────────────────────
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

// ─── Re-list a Traded Item ────────────────────────────────────────────
exports.relistItem = async (req, res) => {
  try {
    const item = await Item.findOne({
      _id: req.params.id,
      owner: req.user.id,
      status: "traded",
    });

    if (!item) {
      return res.status(404).json({
        message: "Item not found, not authorized, or not in traded status",
      });
    }

    item.status = "available";
    await item.save();

    return res.json({
      message: "Item re-listed successfully and is now available for trading",
      item,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Browse by Category ───────────────────────────────────────────────
exports.browseByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 12, 50);
    const skip = (page - 1) * limit;

    const filter = {
      status: "available",
      category: category,
    };

    if (req.query.condition) {
      const conditions = req.query.condition.split(",").map((c) => c.trim());
      filter.condition = { $in: conditions };
    }

    if (req.query.lookingFor) {
      const lookingForOptions = req.query.lookingFor.split(",").map((l) => l.trim());
      filter.lookingFor = { $in: lookingForOptions };
    }

    if (req.query.excludeOwn === "true" && req.user) {
      filter.owner = { $ne: req.user.id };
    }

    let sortOption = { createdAt: -1 };
    if (req.query.sort === "oldest") sortOption = { createdAt: 1 };

    const totalCount = await Item.countDocuments(filter);
    const items = await Item.find(filter)
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .populate("owner", "name email profileImage");

    const totalPages = Math.ceil(totalCount / limit);

    return res.json({
      category,
      page,
      limit,
      totalCount,
      totalPages,
      hasMore: page < totalPages,
      items,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Get Filter Options ──────────────────────────────────────────────
exports.getFilterOptions = async (req, res) => {
  try {
    const [categoryCounts, conditionCounts, lookingForCounts, totalAvailable] = await Promise.all([
      Item.aggregate([
        { $match: { status: "available" } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Item.aggregate([
        { $match: { status: "available" } },
        { $group: { _id: "$condition", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Item.aggregate([
        { $match: { status: "available" } },
        { $group: { _id: "$lookingFor", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Item.countDocuments({ status: "available" }),
    ]);

    return res.json({
      totalAvailable,
      categories: categoryCounts.map((c) => ({ value: c._id, count: c.count })),
      conditions: conditionCounts.map((c) => ({ value: c._id, count: c.count })),
      lookingFor: lookingForCounts.map((l) => ({ value: l._id, count: l.count })),
      sortOptions: [
        { value: "newest", label: "Newest First" },
        { value: "oldest", label: "Oldest First" },
        { value: "title_asc", label: "Title A-Z" },
        { value: "title_desc", label: "Title Z-A" },
      ],
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Get Featured Items ──────────────────────────────────────────────
exports.getFeaturedItems = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 8, 20);

    const items = await Item.aggregate([
      { $match: { status: "available" } },
      { $sample: { size: limit } },
    ]);

    await Item.populate(items, { path: "owner", select: "name email profileImage" });

    return res.json({
      count: items.length,
      items,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
