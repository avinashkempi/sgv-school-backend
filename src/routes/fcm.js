const express = require('express');
const { registerFCMToken, unregisterFCMToken, getRegisteredTokens, cleanupInvalidTokens } = require('../controllers/fcmController');
const { authenticateToken, checkRole } = require('../middleware/auth');

const router = express.Router();

// POST /api/fcm/register - Register the authenticated user's device FCM token
router.post('/register', authenticateToken, registerFCMToken);

// POST /api/fcm/unregister - Unregister the authenticated user's device FCM token
router.post('/unregister', authenticateToken, unregisterFCMToken);

// GET /api/fcm/debug-tokens - List registered tokens (Admin debug only)
router.get('/debug-tokens', authenticateToken, checkRole(['admin', 'super admin']), getRegisteredTokens);

// POST /api/fcm/cleanup-invalid - Remove all invalid Expo tokens (Admin only)
router.post('/cleanup-invalid', authenticateToken, checkRole(['admin', 'super admin']), cleanupInvalidTokens);

module.exports = router;
