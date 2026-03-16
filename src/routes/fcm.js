const express = require('express');
const { registerFCMToken, unregisterFCMToken, getRegisteredTokens, cleanupInvalidTokens } = require('../controllers/fcmController');

const router = express.Router();

// POST /api/fcm/register - Register a device's FCM token
router.post('/register', registerFCMToken);

// POST /api/fcm/unregister - Unregister a device's FCM token
router.post('/unregister', unregisterFCMToken);

// GET /api/fcm/debug-tokens - List registered tokens (Debug only)
router.get('/debug-tokens', getRegisteredTokens);

// POST /api/fcm/cleanup-invalid - Remove all invalid Expo tokens
router.post('/cleanup-invalid', cleanupInvalidTokens);

module.exports = router;
