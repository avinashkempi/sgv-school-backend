const FCMToken = require('../models/FCMToken');

/**
 * Register a device's FCM token
 */
const registerFCMToken = async (req, res) => {
    try {
        const { token, userId, platform, isAuthenticated } = req.body;

        if (!token || !userId || !platform) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: token, userId, platform',
            });
        }

        // Check if token already exists
        let fcmToken = await FCMToken.findOne({ token });

        if (fcmToken) {
            // Update existing token
            fcmToken.userId = userId;
            fcmToken.platform = platform;
            fcmToken.isAuthenticated = isAuthenticated || false;
            fcmToken.updatedAt = new Date();
            await fcmToken.save();


        } else {
            // Create new token
            fcmToken = new FCMToken({
                userId,
                token,
                platform,
                isAuthenticated: isAuthenticated || false,
            });
            await fcmToken.save();


        }

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
 * Unregister a device's FCM token
 */
const unregisterFCMToken = async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({
                success: false,
                message: 'Token is required',
            });
        }

        await FCMToken.deleteOne({ token });

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

module.exports = {
    registerFCMToken,
    unregisterFCMToken,
    getRegisteredTokens
};
