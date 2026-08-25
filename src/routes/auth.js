const express = require('express');
const rateLimit = require('express-rate-limit');
const { loginValidation, changePasswordValidation } = require('../validations/auth');
const { login, getMe, changePassword, updateProfilePhoto } = require('../controllers/authController');

const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP/user to 5 change password attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many password change attempts. Please try again after 15 minutes.'
  }
});

router.post('/login', loginValidation, login);
router.get('/me', authenticateToken, getMe);
router.post('/change-password', authenticateToken, changePasswordLimiter, changePasswordValidation, changePassword);
router.patch('/profile-photo', authenticateToken, updateProfilePhoto);

module.exports = router;
