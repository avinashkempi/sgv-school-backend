const express = require('express');
const { loginValidation } = require('../validations/auth');
const { login, getMe, changePassword } = require('../controllers/authController');

const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.post('/login', loginValidation, login);
router.get('/me', authenticateToken, getMe);
router.post('/change-password', authenticateToken, changePassword);

module.exports = router;
