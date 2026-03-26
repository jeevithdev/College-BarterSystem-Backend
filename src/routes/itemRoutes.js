const express = require("express");
const { body, param, query } = require("express-validator");
const itemController = require("../controllers/itemController");
const auth = require("../middleware/authMiddleware");
const optionalAuth = require("../middleware/optionalAuth");
const router = express.Router();

// ─── Validation Rules ─────────────────────────────────────────────────
const createItemValidation = [
  body("title").trim().notEmpty().withMessage("Title is required").isLength({ max: 200 }),
  body("description").trim().notEmpty().withMessage("Description is required").isLength({ max: 2000 }),
  body("category")
    .isIn(["electronics", "accessories", "books", "home", "other", "vehicle"])
    .withMessage("Invalid category"),
  body("condition")
    .isIn(["new", "like_new", "good", "fair", "damaged"])
    .withMessage("Invalid condition"),
  body("lookingFor")
    .isIn(["item_swap", "credits", "flexible"])
    .withMessage("Invalid lookingFor value"),
  body("images").optional().isArray().withMessage("Images must be an array"),
];

const editItemValidation = [
  body("title").optional().trim().notEmpty().withMessage("Title cannot be empty").isLength({ max: 200 }),
  body("description").optional().trim().notEmpty().withMessage("Description cannot be empty").isLength({ max: 2000 }),
  body("category")
    .optional()
    .isIn(["electronics", "accessories", "books", "home", "other", "vehicle"])
    .withMessage("Invalid category"),
  body("condition")
    .optional()
    .isIn(["new", "like_new", "good", "fair", "damaged"])
    .withMessage("Invalid condition"),
  body("lookingFor")
    .optional()
    .isIn(["item_swap", "credits", "flexible"])
    .withMessage("Invalid lookingFor value"),
  body("images").optional().isArray().withMessage("Images must be an array"),
];

// ─── Browse and Filter Routes (specific routes first) ─────────────────
router.get("/filters", itemController.getFilterOptions);
router.get("/featured", itemController.getFeaturedItems);
router.get("/browse/:category", optionalAuth, itemController.browseByCategory);
router.get("/mine", auth, itemController.getMyItems);

// ─── CRUD Routes ──────────────────────────────────────────────────────
router.post("/", auth, createItemValidation, itemController.createItem);
router.get("/", optionalAuth, itemController.getItems);
router.get("/:id", itemController.getItemDetails);
router.put("/:id", auth, editItemValidation, itemController.editItem);
router.delete("/:id", auth, itemController.deleteItem);
router.post("/:id/relist", auth, itemController.relistItem);

module.exports = router;