const express = require('express');
const {
    registerFCMToken,
    registerPublicFCMToken,
    unregisterFCMToken,
    getRegisteredTokens,
    cleanupInvalidTokens,
} = require('../controllers/fcmController');
const { authenticateToken, checkRole } = require('../middleware/auth');

const router = express.Router();
const requireFcmAdmin = checkRole(['admin', 'super admin']);

// POST /api/fcm/register - Register an authenticated user's device FCM token
router.post('/register', authenticateToken, registerFCMToken);

// POST /api/fcm/register-public - Register a guest/public device FCM token
router.post('/register-public', registerPublicFCMToken);

// POST /api/fcm/unregister - Unregister an authenticated user's device FCM token
router.post('/unregister', authenticateToken, unregisterFCMToken);

// GET /api/fcm/debug-tokens - List registered tokens (Admin/debug only)
router.get('/debug-tokens', authenticateToken, requireFcmAdmin, getRegisteredTokens);

// POST /api/fcm/cleanup-invalid - Remove all invalid Expo tokens
router.post('/cleanup-invalid', authenticateToken, requireFcmAdmin, cleanupInvalidTokens);

module.exports = router;
