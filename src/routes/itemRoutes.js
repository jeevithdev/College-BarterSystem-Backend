const express = require('express');
const itemController = require('../controllers/itemController');
const auth = require('../middleware/authMiddleware');
const optionalAuth = require('../middleware/optionalAuth');
const router = express.Router();

// Browse and filter routes (specific routes first)
router.get('/filters', itemController.getFilterOptions);
router.get('/featured', itemController.getFeaturedItems);
router.get('/browse/:category', optionalAuth, itemController.browseByCategory);
router.get('/mine', auth, itemController.getMyItems);

// CRUD routes
router.post('/', auth, itemController.createItem);
router.get('/', optionalAuth, itemController.getItems);
router.get('/:id', itemController.getItemDetails);
router.put('/:id', auth, itemController.editItem);
router.delete('/:id', auth, itemController.deleteItem);
router.post('/:id/relist', auth, itemController.relistItem);

module.exports = router;