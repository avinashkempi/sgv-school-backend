const FCMToken = require('../models/FCMToken');
const path = require('path');

// Firebase Admin will be initialized with a warning if credentials are not available
// This allows the app to run without Firebase, but notifications won't work
let admin;
try {
    admin = require('firebase-admin');

    // Check if Firebase is already initialized
    if (!admin.apps.length) {
        let serviceAccount = null;

        // Try to load from environment variable first (for production/Render)
        if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {

            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        }
        // Otherwise try to load from file path (for local development)
        else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
            const absolutePath = path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

            serviceAccount = require(absolutePath);
        }

        if (serviceAccount) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });

        } else {
            console.warn('⚠️  Firebase credentials not found. Push notifications will not work.');
            console.warn('⚠️  Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH environment variable');
            admin = null; // Set to null if not properly initialized
        }
    }
} catch (error) {
    console.error('❌ Failed to initialize Firebase Admin SDK:', error.message);
    console.warn('⚠️  Push notifications will not work until Firebase is properly configured');
    admin = null;
}

/**
 * Send push notification to multiple devices
 * @param {Array} tokens - Array of FCM tokens
 * @param {Object} notification - Notification payload
 * @param {Object} data - Data payload (optional)
 */
async function sendBatchNotifications(tokens, notification, data = {}) {
    if (!admin) {
        console.warn('[Notifications] Firebase Admin not initialized, skipping notification send');
        return { success: false, error: 'Firebase not configured' };
    }

    if (!tokens || tokens.length === 0) {

        return { success: true, successCount: 0, failureCount: 0 };
    }

    try {
        // Firebase supports sending to max 500 tokens at once
        const batchSize = 500;
        const batches = [];

        for (let i = 0; i < tokens.length; i += batchSize) {
            batches.push(tokens.slice(i, i + batchSize));
        }

        let totalSuccess = 0;
        let totalFailure = 0;
        const failedTokens = [];

        for (const batch of batches) {
            const message = {
                notification,
                data,
                tokens: batch,
            };

            const response = await admin.messaging().sendEachForMulticast(message);

            totalSuccess += response.successCount;
            totalFailure += response.failureCount;

            // Remove failed/invalid tokens from database
            if (response.failureCount > 0) {
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        failedTokens.push(batch[idx]);
                        console.error(`[Notifications] Failed to send to token:`, resp.error?.message || 'Unknown error');
                    }
                });
            }
        }

        // Clean up invalid tokens
        if (failedTokens.length > 0) {
            await FCMToken.deleteMany({ token: { $in: failedTokens } });

        }



        return {
            success: true,
            successCount: totalSuccess,
            failureCount: totalFailure,
        };
    } catch (error) {
        console.error('[Notifications] Send error:', error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * Send notification when news is created
 * @param {Object} newsData - The created news object
 */
async function sendNewsNotification(newsData) {
    try {
        if (!admin) {
            console.warn('[Notifications] Firebase not initialized, skipping news notification');
            return { success: false, error: 'Firebase not configured' };
        }

        const { title, description, privateNews, _id } = newsData;




        // Get tokens based on privateNews flag
        let tokenQuery = {};

        if (privateNews) {
            // Private news: only send to authenticated users
            tokenQuery = { isAuthenticated: true };

        } else {
            // Public news: send to all users (authenticated + guests)

        }

        const fcmTokenDocs = await FCMToken.find(tokenQuery);
        const tokens = fcmTokenDocs.map(doc => doc.token);



        if (tokens.length === 0) {

            return { success: true, message: 'No tokens to send to' };
        }

        const notification = {
            title: '📰 New News Update',
            body: title,
        };

        const data = {
            type: 'news',
            newsId: _id.toString(),
            title,
            description: description.substring(0, 100),
            privateNews: privateNews.toString(),
        };

        const result = await sendBatchNotifications(tokens, notification, data);

        return result;
    } catch (error) {
        console.error('[Notifications] Error sending news notification:', error);
        return { success: false, error: error.message };
    }
}



/**
 * Send notification when class content is posted
 * @param {string} classId - The ID of the class
 * @param {Object} content - The content object (title, type, etc.)
 */
async function sendClassContentNotification(classId, content) {
    try {
        if (!admin) {
            console.warn('[Notifications] Firebase not initialized, skipping class notification');
            return { success: false, error: 'Firebase not configured' };
        }

        const User = require('../models/User');

        // Find all students in the class
        const students = await User.find({ currentClass: classId, role: 'student' }).select('_id');
        const studentIds = students.map(s => s._id);

        if (studentIds.length === 0) {

            return { success: true, message: 'No students in class' };
        }

        // Find FCM tokens for these students
        const fcmTokenDocs = await FCMToken.find({ userId: { $in: studentIds } });
        const tokens = fcmTokenDocs.map(doc => doc.token);



        if (tokens.length === 0) {
            return { success: true, message: 'No tokens found for students' };
        }

        const notification = {
            title: `New ${content.type}: ${content.title}`,
            body: content.description ? content.description.substring(0, 100) : 'Check the app for details',
        };

        const data = {
            type: 'class_content',
            contentId: content._id.toString(),
            contentType: content.type,
            classId: classId.toString()
        };

        return await sendBatchNotifications(tokens, notification, data);

    } catch (error) {
        console.error('[Notifications] Error sending class notification:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Send targeted notification based on criteria
 * @param {string} target - The target type ('all', 'class', 'user', 'teacher', 'staff')
 * @param {string} targetId - The ID of the target (if applicable)
 * @param {Object} notificationData - The notification data { title, message, type }
 */
async function sendTargetedNotification(target, targetId, notificationData) {
    try {
        if (!admin) {
            console.warn('[Notifications] Firebase not initialized, skipping targeted notification');
            return { success: false, error: 'Firebase not configured' };
        }

        const User = require('../models/User');
        let userIds = [];
        let tokenQuery = {};

        // Determine which users to send to
        if (target === 'user') {
            if (targetId) userIds = [targetId];
        } else if (target === 'class') {
            if (targetId) {
                const students = await User.find({ currentClass: targetId, role: 'student' }).select('_id');
                userIds = students.map(s => s._id);
            }
        } else if (target === 'teacher') {
            const teachers = await User.find({ role: 'teacher' }).select('_id');
            userIds = teachers.map(t => t._id);
        } else if (target === 'staff') {
            const staff = await User.find({ role: { $in: ['staff', 'support_staff'] } }).select('_id');
            userIds = staff.map(s => s._id);
        } else if (target === 'all') {
            // No user filtering, send to all tokens
            userIds = null;
        }

        // Build token query
        if (userIds) {
            if (userIds.length === 0) {
                console.log(`[Notifications] No users found for target: ${target}`);
                return { success: true, message: 'No users found for target' };
            }
            tokenQuery = { userId: { $in: userIds } };
        } else {
            // Send to all
            tokenQuery = {};
        }

        const fcmTokenDocs = await FCMToken.find(tokenQuery);
        const tokens = fcmTokenDocs.map(doc => doc.token);

        console.log(`[Notifications] Sending notification to ${tokens.length} devices (Target: ${target})`);

        if (tokens.length === 0) {
            return { success: true, message: 'No tokens found' };
        }

        const notification = {
            title: notificationData.title,
            body: notificationData.message,
        };

        const data = {
            type: 'general',
            notificationType: notificationData.type || 'General',
            target: target,
            targetId: targetId ? targetId.toString() : '',
        };

        return await sendBatchNotifications(tokens, notification, data);

    } catch (error) {
        console.error('[Notifications] Error sending targeted notification:', error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    sendBatchNotifications,
    sendNewsNotification,
    sendClassContentNotification,
    sendTargetedNotification
};
