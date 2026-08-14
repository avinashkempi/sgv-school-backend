const FCMToken = require('../models/FCMToken');
const NotificationPreference = require('../models/NotificationPreference');
const path = require('path');
const logger = require('../utils/logger');

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
            logger.warn('⚠️  Firebase credentials not found. Push notifications will not work.');
            logger.warn('⚠️  Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH environment variable');
            admin = null; // Set to null if not properly initialized
        }
    }
} catch (error) {
    logger.error('❌ Failed to initialize Firebase Admin SDK:', error);
    logger.warn('⚠️  Push notifications will not work until Firebase is properly configured');
    admin = null;
}

// ─────────────────────────────────────────────────────────────
// Quiet Hours Check
// ─────────────────────────────────────────────────────────────

/**
 * Check if the current IST time falls within a user's quiet hours.
 * @param {string} quietStart - "HH:MM" e.g. "22:00"
 * @param {string} quietEnd   - "HH:MM" e.g. "07:00"
 * @returns {boolean} true if currently in quiet hours
 */
function isInQuietHours(quietStart, quietEnd) {
    if (!quietStart || !quietEnd) return false;

    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    const currentMinutes = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();

    const [startH, startM] = quietStart.split(':').map(Number);
    const [endH, endM] = quietEnd.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Handles overnight quiet hours (e.g., 22:00 to 07:00)
    if (startMinutes <= endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
        return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
}

// ─────────────────────────────────────────────────────────────
// Core: Batch Push Notification Sender
// ─────────────────────────────────────────────────────────────

/**
 * Send push notification to multiple devices
 * @param {Array} tokens - Array of FCM tokens
 * @param {Object} notification - Notification payload
 * @param {Object} data - Data payload (optional)
 */
async function sendBatchNotifications(tokens, notification, data = {}) {
    if (!admin) {
        logger.warn('[Notifications] Firebase Admin not initialized, skipping notification send');
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
                        const errorCode = resp.error?.code;
                        const errorMsg = resp.error?.message || 'Unknown error';
                        
                        // Categorize errors for better debugging
                        if (errorCode === 'messaging/invalid-registration-token' || 
                            errorCode === 'messaging/registration-token-not-registered' ||
                            errorMsg.includes('Requested entity was not found') ||
                            errorMsg.includes('NotRegistered') ||
                            errorMsg.includes('not a valid FCM registration token')) {
                            logger.warn('[Notifications] Invalid/Expired token removed (will delete from DB)');
                        } else if (errorCode === 'messaging/mismatched-credential' || errorMsg.includes('SenderId mismatch')) {
                            logger.error('[Notifications] SenderId Mismatch Error — Firebase config mismatch between app build and backend');
                        } else {
                            logger.error(`[Notifications] Failed to send — Error: ${errorMsg} (Code: ${errorCode})`);
                        }
                    }
                });
            }
        }

        // Clean up invalid tokens
        if (failedTokens.length > 0) {
            try {
                const result = await FCMToken.deleteMany({ token: { $in: failedTokens } });
                logger.info(`[Notifications] Cleaned up ${result.deletedCount} invalid FCM tokens`);
            } catch (cleanupErr) {
                logger.error('[Notifications] Error cleaning up invalid tokens:', cleanupErr);
            }
        }

        return {
            success: true,
            successCount: totalSuccess,
            failureCount: totalFailure,
        };
    } catch (error) {
        logger.error('[Notifications] Send error:', error);
        return {
            success: false,
            error: error.message,
        };
    }
}

// ─────────────────────────────────────────────────────────────
// Class Content Notification
// ─────────────────────────────────────────────────────────────

/**
 * Send notification when class content is posted
 * @param {string} classId - The ID of the class
 * @param {Object} content - The content object (title, type, etc.)
 */
async function sendClassContentNotification(classId, content) {
    try {
        if (!admin) {
            logger.warn('[Notifications] Firebase not initialized, skipping class notification');
            return { success: false, error: 'Firebase not configured' };
        }

        const User = require('../models/User');

        // Find all students in the class
        const students = await User.find({ currentClass: classId, role: 'student' }).select('_id');
        const studentIds = students.map(s => s._id);

        if (studentIds.length === 0) {
            logger.info(`[Notifications] No students found in class: ${classId}`);
            return { success: true, message: 'No students in class' };
        }

        // Find FCM tokens for these students
        const fcmTokenDocs = await FCMToken.find({ userId: { $in: studentIds } });
        const tokens = fcmTokenDocs.map(doc => doc.token);

        if (tokens.length === 0) {
            logger.info(`[Notifications] No FCM tokens registered for ${studentIds.length} students in class`);
            return { success: true, message: 'No tokens found for students' };
        }

        const contentType = content.type || 'Content';
        const notification = {
            title: `📚 New ${contentType}: ${content.title}`,
            body: content.description ? content.description.substring(0, 100) : 'New content has been posted. Open the app to view it.',
        };

        const data = {
            type: 'class_content',
            contentId: content._id.toString(),
            contentType: content.type,
            classId: classId.toString()
        };

        return await sendBatchNotifications(tokens, notification, data);

    } catch (error) {
        logger.error('[Notifications] Error sending class notification:', error);
        return { success: false, error: error.message };
    }
}

// ─────────────────────────────────────────────────────────────
// Preference-Aware Targeted Notification
// ─────────────────────────────────────────────────────────────

/**
 * Send targeted notification based on criteria, respecting user preferences.
 * @param {string} target - The target type ('all', 'class', 'user', 'teacher', 'staff', etc.)
 * @param {string} targetId - The ID of the target (if applicable)
 * @param {Object} notificationData - { title, message, type, category, priority }
 * @param {boolean} sendToPublic - Whether to include non-authenticated users
 */
async function sendTargetedNotification(target, targetId, notificationData, sendToPublic = false) {
    try {
        if (!admin) {
            logger.warn('[Notifications] Firebase not initialized, skipping targeted notification');
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
        } else if (target === 'admin') {
            const admins = await User.find({ role: 'admin' }).select('_id');
            userIds = admins.map(a => a._id);
        } else if (target === 'super admin') {
            const superAdmins = await User.find({ role: 'super admin' }).select('_id');
            userIds = superAdmins.map(a => a._id);
        } else if (target === 'staff') {
            const staff = await User.find({ role: { $in: ['staff', 'support_staff'] } }).select('_id');
            userIds = staff.map(s => s._id);
        } else if (target === 'support_staff') {
            const supportStaff = await User.find({ role: 'support_staff' }).select('_id');
            userIds = supportStaff.map(s => s._id);
        } else if (target === 'all') {
            // No user filtering, send to all tokens
            userIds = null;
        }

        // Build token query
        if (userIds) {
            if (userIds.length === 0) {
                logger.info(`[Notifications] No users found for target: ${target}`);
                return { success: true, message: 'No users found for target' };
            }
            tokenQuery = { userId: { $in: userIds } };
        } else {
            // Send to all
            tokenQuery = {};
        }
        
        // By default, only send to authenticated users. If sendToPublic is true, include all users.
        if (!sendToPublic) {
            tokenQuery.isAuthenticated = true;
        }

        const fcmTokenDocs = await FCMToken.find(tokenQuery);

        if (fcmTokenDocs.length === 0) {
            logger.info(`[Notifications] No devices to notify (Target: ${target}, UserCount: ${userIds ? userIds.length : 'all'})`);
            return { success: true, message: 'No tokens found', successCount: 0, failureCount: 0 };
        }

        // ── Preference-based filtering ──
        // Skip filtering for targets that don't map to individual users (e.g., public broadcasts)
        const category = notificationData.category || 'general';
        const priority = notificationData.priority || 'medium';
        let filteredTokens = fcmTokenDocs.map(doc => doc.token);

        if (userIds && userIds.length > 0) {
            // Batch-fetch preferences for all target users
            const preferences = await NotificationPreference.find({
                user: { $in: userIds },
            }).lean();

            const prefMap = new Map();
            for (const pref of preferences) {
                prefMap.set(pref.user.toString(), pref);
            }

            // Filter out tokens for users who have opted out
            const excludedUserIds = new Set();

            for (const uid of userIds) {
                const uidStr = uid.toString();
                const pref = prefMap.get(uidStr);
                if (!pref) continue; // No preferences saved → use defaults (all enabled)

                // Check if push is globally disabled
                if (pref.pushEnabled === false) {
                    excludedUserIds.add(uidStr);
                    continue;
                }

                // Check category preference
                if (pref.categories && pref.categories[category] === false) {
                    excludedUserIds.add(uidStr);
                    continue;
                }

                // Check priority preference
                if (pref.priorities && pref.priorities[priority] === false) {
                    excludedUserIds.add(uidStr);
                    continue;
                }

                // Check quiet hours
                if (pref.quietHoursEnabled && isInQuietHours(pref.quietHoursStart, pref.quietHoursEnd)) {
                    excludedUserIds.add(uidStr);
                    continue;
                }
            }

            if (excludedUserIds.size > 0) {
                filteredTokens = fcmTokenDocs
                    .filter(doc => !excludedUserIds.has(doc.userId?.toString()))
                    .map(doc => doc.token);

                logger.info(`[Notifications] Excluded ${excludedUserIds.size} user(s) based on preferences`);
            }
        }

        if (filteredTokens.length === 0) {
            logger.info(`[Notifications] All target users opted out of this notification`);
            return { success: true, message: 'All users opted out', successCount: 0, failureCount: 0 };
        }
        
        logger.info(`[Notifications] Sending notification to ${filteredTokens.length} devices (Target: ${target})`);

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

        return await sendBatchNotifications(filteredTokens, notification, data);

    } catch (error) {
        logger.error('[Notifications] Error sending targeted notification:', error);
        return { success: false, error: error.message };
    }
}

module.exports = {
    sendBatchNotifications,
    sendClassContentNotification,
    sendTargetedNotification
};
