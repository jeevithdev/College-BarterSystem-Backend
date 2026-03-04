const express = require('express');
const itemController = require('../controllers/itemController');
const auth = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/',auth,itemController.createItem);
router.get('/',itemController.getItems);
router.get('/mine',auth,itemController.getMyItems);
router.get('/:id',itemController.getItemDetails);
router.put('/:id',auth,itemController.editItem);
router.delete('/:id',auth,itemController.deleteItem);
router.post('/:id/relist',auth,itemController.relistItem);

module.exports = router;