const FCMToken = require('../models/FCMToken');

/**
 * Validate FCM token format
 * Firebase tokens should NOT be Expo tokens (ExponentPushToken)
 */
function isValidFCMToken(token) {
    if (!token || typeof token !== 'string') return false;
    if (token.trim().length === 0) return false;
    // Reject Expo tokens - they don't work with Firebase
    if (token.startsWith('ExponentPushToken')) {
        console.warn(`[FCM] Rejecting invalid Expo token: ${token}`);
        return false;
    }
    // Basic length validation
    if (token.length < 20) return false;
    return true;
}

function getPublicUserId(req) {
    const publicRegistrationId = req.body.publicRegistrationId || req.body.guestId || req.body.deviceId || req.body.installationId;

    if (!publicRegistrationId || typeof publicRegistrationId !== 'string' || publicRegistrationId.trim().length === 0) {
        return null;
    }

    return `guest:${publicRegistrationId.trim()}`;
}

async function upsertFCMToken({ token, userId, platform, isAuthenticated }) {
    // Atomic upsert — avoids duplicate key errors from race conditions
    return FCMToken.findOneAndUpdate(
        { token },
        {
            $set: {
                userId,
                platform,
                isAuthenticated,
                updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true, new: true }
    );
}

/**
 * Register an authenticated user's FCM token.
 * Client-supplied userId/isAuthenticated values are intentionally ignored.
 */
const registerFCMToken = async (req, res) => {
    try {
        const { token, platform } = req.body;
        const userId = req.user && req.user.userId;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Authenticated user is required',
            });
        }
        if (!token || !platform) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: token, platform',
            });
        }

        // Validate token format
        if (!isValidFCMToken(token)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid FCM token. Ensure you are using a Development Build and not Expo Go.',
            });
        }

        const fcmToken = await upsertFCMToken({
            token,
            userId,
            platform,
            isAuthenticated: true,
        });

        res.status(200).json({
            success: true,
            message: 'FCM token registered successfully',
            tokenId: fcmToken._id,
        });
    } catch (error) {
        console.error('[FCM] Registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to register FCM token',
            error: error.message,
        });
    }
};

/**
 * Register a guest/public FCM token.
 * This endpoint never accepts a userId and always stores a guest-prefixed identifier.
 */
const registerPublicFCMToken = async (req, res) => {
    try {
        const { token, platform } = req.body;
        const userId = getPublicUserId(req);

        if (!token || !platform || !userId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: token, platform, and one of publicRegistrationId, guestId, deviceId, or installationId',
            });
        }

        // Validate token format
        if (!isValidFCMToken(token)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid FCM token. Ensure you are using a Development Build and not Expo Go.',
            });
        }

        const fcmToken = await upsertFCMToken({
            token,
            userId,
            platform,
            isAuthenticated: false,
        });

        res.status(200).json({
            success: true,
            message: 'Public FCM token registered successfully',
            tokenId: fcmToken._id,
        });
    } catch (error) {
        console.error('[FCM] Public registration error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to register public FCM token',
            error: error.message,
        });
    }
};

/**
 * Unregister an authenticated user's FCM token
 */
const unregisterFCMToken = async (req, res) => {
    try {
        const { token } = req.body;
        const userId = req.user && req.user.userId;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Authenticated user is required',
            });
        }

        if (!token) {
            return res.status(400).json({
                success: false,
                message: 'Token is required',
            });
        }

        await FCMToken.deleteOne({ token, userId });

        res.status(200).json({
            success: true,
            message: 'FCM token unregistered successfully',
        });
    } catch (error) {
        console.error('[FCM] Unregistration error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unregister FCM token',
            error: error.message,
        });
    }
};

/**
 * Get registered FCM tokens for debugging
 */
const getRegisteredTokens = async (req, res) => {
    try {
        const count = await FCMToken.countDocuments();
        const tokens = await FCMToken.find().sort({ updatedAt: -1 }).limit(10);

        res.status(200).json({
            success: true,
            count,
            recentTokens: tokens.map(t => ({
                id: t._id,
                userId: t.userId,
                platform: t.platform,
                isAuthenticated: t.isAuthenticated,
                updatedAt: t.updatedAt,
                // Mask token for security, show last 6 chars
                tokenMask: '...' + t.token.slice(-6)
            }))
        });
    } catch (error) {
        console.error('[FCM] Debug error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * Clean up invalid Expo tokens (emergency cleanup)
 * This removes all tokens starting with "ExponentPushToken" which don't work with Firebase
 */
const cleanupInvalidTokens = async (req, res) => {
    try {
        // Find all Expo tokens
        const result = await FCMToken.deleteMany({
            token: { $regex: '^ExponentPushToken' }
        });

        console.log(`[FCM] Cleaned up ${result.deletedCount} invalid Expo tokens`);

        res.status(200).json({
            success: true,
            message: `Removed ${result.deletedCount} invalid Expo tokens`,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        console.error('[FCM] Cleanup error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to cleanup invalid tokens',
            error: error.message
        });
    }
};

module.exports = {
    registerFCMToken,
    registerPublicFCMToken,
    unregisterFCMToken,
    getRegisteredTokens,
    cleanupInvalidTokens
};
