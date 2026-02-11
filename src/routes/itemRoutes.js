const express = require('express');
const itemController = require('../controllers/itemController');
const auth = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/',auth,itemController.createItem);
router.get('/',itemController.getItems);
router.get('/:id',itemController.getItemDetails);
router.get('/mine',auth,itemController.getMyItems);
router.delete('/:id',auth,itemController.deleteItem);

module.exports = router;