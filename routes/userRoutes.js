const express = require('express');
const { addEmail } = require('../controllers/UserEmailController');

const router = express.Router();

router.post('/add-email', addEmail);

module.exports = router;