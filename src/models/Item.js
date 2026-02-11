const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      required: true,
      trim: true,
    },

    category: {
      type: String,
      enum: ["electronics", "accessories", "books", "home", "other","vehicle"],
      required: true,
    },

    condition: {
      type: String,
      enum: ["new", "like_new", "good", "fair", "damaged"],
      required: true,
    },

    images: {
      type: [String],
      default: [],
    },

    lookingFor: {
      type: String,
      enum: ["item_swap", "credits", "flexible"],
      required: true,
    },

    status: {
      type: String,
      enum: ["available", "traded"],
      default: "available",
    },

    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Item", itemSchema);
