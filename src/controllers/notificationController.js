const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const User = require('../models/User');
const { sendTargetedNotification } = require('../services/notificationService');
const { cacheGet, cacheSet, cacheDel, cacheInvalidatePattern } = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Helper to build query for notifications visible to a specific user
 */
const buildUserNotificationsQuery = async (user, isArchived = false) => {
    const userId = user?.userId || user?.id || user?._id;
    const userRole = user?.role;

    // Handle ObjectId vs String safely for MongoDB matching & aggregation
    const userObjectId = (userId && mongoose.Types.ObjectId.isValid(userId))
        ? new mongoose.Types.ObjectId(userId)
        : null;

    const recipientClauses = [
        ...(userId ? [{ recipient: userId }] : []),
        ...(userObjectId ? [{ recipient: userObjectId }] : [])
    ];

    let orClauses = [
        ...recipientClauses
    ];

    if (userRole === 'super admin') {
        // Super admin sees all broadcast notifications (recipient: null)
        orClauses.push({ recipient: null });
    } else if (userRole === 'admin') {
        // Admin sees broadcast notifications targeted to 'all' or 'admin'
        orClauses.push({
            recipient: null,
            targetRole: { $in: ['all', 'admin'] }
        });
    } else if (userRole === 'student') {
        // Student sees role-targeted notifications
        orClauses.push({
            recipient: null,
            targetClass: null,
            targetRole: { $in: ['all', 'student'] }
        });

        // Plus class-targeted notifications
        const currentClass = user.currentClass || (userId ? (await User.findById(userId).select('currentClass').lean())?.currentClass : null);
        if (currentClass) {
            const classObjectId = mongoose.Types.ObjectId.isValid(currentClass)
                ? new mongoose.Types.ObjectId(currentClass)
                : null;
            orClauses.push({
                recipient: null,
                targetClass: classObjectId ? { $in: [currentClass, classObjectId] } : currentClass
            });
        }
    } else {
        // Teachers, staff, support_staff, etc.
        orClauses.push({
            recipient: null,
            targetClass: null,
            targetRole: { $in: ['all', userRole] }
        });
    }

    return {
        isArchived: Boolean(isArchived),
        $or: orClauses
    };
};

/**
 * Helper to retrieve user's notification watermark (lastNotificationReadAt)
 */
const getUserWatermark = async (user) => {
    if (user?.lastNotificationReadAt) {
        return new Date(user.lastNotificationReadAt);
    }
    const userId = user?.userId || user?.id || user?._id;
    if (!userId) return null;
    const userDoc = await User.findById(userId).select('lastNotificationReadAt').lean();
    return userDoc?.lastNotificationReadAt ? new Date(userDoc.lastNotificationReadAt) : null;
};

/**
 * Helper to resolve whether a specific notification is read for a given user
 */
const resolveNotificationReadState = (notif, userId, userObjectId, watermark) => {
    const isPersonal = Boolean(notif.recipient);
    if (isPersonal) {
        return {
            isRead: Boolean(notif.isRead),
            readAt: notif.readAt || null
        };
    }

    // Broadcast notification resolution:
    // 1. Covered by watermark (read all occurred at or after creation)
    const isBeforeWatermark = watermark && new Date(notif.createdAt) <= watermark;
    // 2. Individually read by this user
    const isIndividuallyRead = Array.isArray(notif.readBy) && (
        notif.readBy.some(id => id.toString() === userId.toString())
    );
    // 3. Fallback to existing flag
    const isGloballyRead = Boolean(notif.isRead);

    const isRead = isBeforeWatermark || isIndividuallyRead || isGloballyRead;
    const readAt = isBeforeWatermark
        ? watermark
        : (notif.readAt || (isIndividuallyRead ? notif.updatedAt : null));

    return { isRead, readAt };
};

/**
 * Get notifications for current user with filtering
 */
exports.getNotifications = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        const { category, isRead, isArchived = 'false' } = req.query;

        const userId = req.user.userId || req.user.id || req.user._id;
        const userObjectId = (userId && mongoose.Types.ObjectId.isValid(userId))
            ? new mongoose.Types.ObjectId(userId)
            : null;

        const [baseQuery, watermark] = await Promise.all([
            buildUserNotificationsQuery(req.user, isArchived === 'true'),
            getUserWatermark(req.user)
        ]);

        let query = { ...baseQuery };

        // Filter by category
        if (category && category !== 'all') {
            query.category = category;
        }

        // Fetch paginated notifications
        const [rawNotifications, total] = await Promise.all([
            Notification.find(query)
                .select('-__v')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Notification.countDocuments(query)
        ]);

        // Compute per-user read state using Watermark and read receipts
        const formattedNotifications = rawNotifications.map(notif => {
            const { isRead: computedIsRead, readAt: computedReadAt } = resolveNotificationReadState(
                notif,
                userId,
                userObjectId,
                watermark
            );
            return {
                ...notif,
                isRead: computedIsRead,
                readAt: computedReadAt
            };
        });

        // Filter by computed read status if requested by client
        let resultNotifications = formattedNotifications;
        if (isRead !== undefined) {
            const requestedRead = isRead === 'true';
            resultNotifications = formattedNotifications.filter(n => n.isRead === requestedRead);
        }

        // Calculate accurate unread count using the watermark query
        const unreadFilter = {
            ...baseQuery,
            isArchived: false,
            $or: [
                {
                    recipient: userObjectId ? { $in: [userId, userObjectId] } : userId,
                    isRead: false
                },
                {
                    recipient: null,
                    isRead: { $ne: true },
                    ...(watermark ? { createdAt: { $gt: watermark } } : {}),
                    ...(userObjectId ? { readBy: { $ne: userObjectId } } : {})
                }
            ]
        };

        const unreadCount = await Notification.countDocuments(unreadFilter);

        res.json({
            success: true,
            notifications: resultNotifications,
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalNotifications: total,
            unreadCount
        });
    } catch (err) {
        console.error('[Notification Controller] Get Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Get unread notification count
 */
exports.getUnreadCount = async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id || req.user._id;
        const cacheKey = `unreadCount:${userId}`;

        // 1. Check Redis cache (30s TTL)
        try {
            const cachedCount = await cacheGet(cacheKey);
            if (cachedCount !== null && typeof cachedCount.unreadCount === 'number') {
                return res.json({ success: true, unreadCount: cachedCount.unreadCount });
            }
        } catch (_) {}

        const userObjectId = (userId && mongoose.Types.ObjectId.isValid(userId))
            ? new mongoose.Types.ObjectId(userId)
            : null;

        const [baseQuery, watermark] = await Promise.all([
            buildUserNotificationsQuery(req.user, false),
            getUserWatermark(req.user)
        ]);

        const unreadFilter = {
            ...baseQuery,
            isArchived: false,
            $or: [
                {
                    recipient: userObjectId ? { $in: [userId, userObjectId] } : userId,
                    isRead: false
                },
                {
                    recipient: null,
                    isRead: { $ne: true },
                    ...(watermark ? { createdAt: { $gt: watermark } } : {}),
                    ...(userObjectId ? { readBy: { $ne: userObjectId } } : {})
                }
            ]
        };

        const count = await Notification.countDocuments(unreadFilter);

        // Store in Redis with 30s TTL
        cacheSet(cacheKey, { unreadCount: count }, 30).catch(() => {});

        res.json({ success: true, unreadCount: count });
    } catch (err) {
        console.error('[Notification Controller] Unread Count Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Mark a single notification as read/unread
 */
exports.markAsRead = async (req, res) => {
    try {
        const isRead = req.body && req.body.isRead !== undefined ? req.body.isRead : true;
        const notificationId = req.params.id;
        const userId = req.user.userId || req.user.id || req.user._id;
        const userObjectId = (userId && mongoose.Types.ObjectId.isValid(userId))
            ? new mongoose.Types.ObjectId(userId)
            : null;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(notificationId)) {
            return res.status(400).json({ success: false, message: 'Invalid notification ID' });
        }

        const notification = await Notification.findById(notificationId);
        if (!notification) {
            return res.status(404).json({ success: false, message: 'Notification not found or already deleted' });
        }

        const isPersonal = notification.recipient && notification.recipient.toString() === userId.toString();
        const isBroadcast = !notification.recipient;
        const isAdminOverride = req.user.role === 'admin' || req.user.role === 'super admin';

        if (!isPersonal && !isBroadcast && !isAdminOverride) {
            return res.status(403).json({ success: false, message: 'Not authorised to modify this notification' });
        }

        if (isPersonal) {
            notification.isRead = isRead;
            notification.readAt = isRead ? new Date() : null;
            await notification.save();
        } else if (userObjectId) {
            // Isolate broadcast read state per user via readBy array
            if (isRead) {
                await Notification.findByIdAndUpdate(notificationId, {
                    $addToSet: { readBy: userObjectId }
                });
            } else {
                await Notification.findByIdAndUpdate(notificationId, {
                    $pull: { readBy: userObjectId }
                });
            }
        }

        // Invalidate unread count cache for requesting user
        cacheDel(`unreadCount:${userId}`).catch(() => {});

        res.json({
            success: true,
            notification: {
                ...notification.toObject(),
                isRead
            }
        });
    } catch (err) {
        console.error('[Notification Controller] Mark Read Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Mark all notifications as read for current user
 */
exports.markAllAsRead = async (req, res) => {
    try {
        const userId = req.user.userId || req.user.id || req.user._id;
        const userObjectId = (userId && mongoose.Types.ObjectId.isValid(userId))
            ? new mongoose.Types.ObjectId(userId)
            : null;
        const now = new Date();

        // 1. Advance the user's watermark timestamp (O(1) isolated operation)
        await User.findByIdAndUpdate(userId, { lastNotificationReadAt: now });

        // 2. Mark any personal direct notifications addressed to this user as read
        const personalRecipientFilter = userObjectId ? { $in: [userId, userObjectId] } : userId;
        const personalResult = await Notification.updateMany(
            {
                recipient: personalRecipientFilter,
                isRead: false,
                isArchived: false
            },
            { $set: { isRead: true, readAt: now } }
        );

        // 3. Invalidate auth user cache and Redis unread count cache
        const { invalidateUserCache } = require('../middleware/auth');
        invalidateUserCache(userId);
        cacheDel(`unreadCount:${userId}`).catch(() => {});

        res.json({
            success: true,
            message: 'All notifications marked as read',
            watermark: now,
            modifiedCount: personalResult.modifiedCount
        });
    } catch (err) {
        console.error('[Notification Controller] Mark All Read Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Archive/Unarchive notification
 */
exports.archiveNotification = async (req, res) => {
    try {
        const { isArchived = true } = req.body;
        
        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid notification ID' });
        }
        
        const notification = await Notification.findById(req.params.id);

        if (!notification) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        // Only allow archiving if this notification is addressed to the requesting user
        const isPersonal = notification.recipient?.toString() === req.user.userId;
        const isBroadcast = !notification.recipient;
        const isAdminOverride = req.user.role === 'admin' || req.user.role === 'super admin';
        if (!isPersonal && !isBroadcast && !isAdminOverride) {
            return res.status(403).json({ success: false, message: 'Not authorised to modify this notification' });
        }

        notification.isArchived = isArchived;
        notification.archivedAt = isArchived ? new Date() : null;
        await notification.save();

        // Invalidate unread count cache
        cacheDel(`unreadCount:${req.user.userId}`).catch(() => {});

        res.json({ success: true, notification });
    } catch (err) {
        console.error('[Notification Controller] Archive Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Delete notification (admin only)
 */
exports.deleteNotification = async (req, res) => {
    try {
        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid notification ID' });
        }
        
        const notification = await Notification.findByIdAndDelete(req.params.id);

        if (!notification) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        // Invalidate unread counts across all users
        cacheInvalidatePattern('unreadCount:*').catch(() => {});

        res.json({ success: true, message: 'Notification deleted' });
    } catch (err) {
        console.error('[Notification Controller] Delete Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Send a notification (Admin only)
 */
exports.sendNotification = async (req, res) => {
    try {
        const { title, message, type, category, priority, target, targetId, actionType, actionData, metadata, sendToPublic } = req.body;

        let recipient = null;
        let targetClass = null;
        let targetRole = 'all';

        if (target === 'user') {
            recipient = targetId;
        } else if (target === 'class') {
            targetClass = targetId;
            targetRole = 'student';
        } else if (target === 'teacher') {
            targetRole = 'teacher';
        } else if (target === 'staff') {
            targetRole = 'staff';
        } else if (target === 'support_staff') {
            targetRole = 'support_staff';
        } else if (target === 'admin') {
            targetRole = 'admin';
        }

        const notification = new Notification({
            title,
            message,
            type: type || 'General',
            category: category || 'general',
            priority: priority || 'medium',
            recipient,
            targetClass,
            targetRole,
            sendToPublic: sendToPublic || false,
            actionType: actionType || 'none',
            actionData,
            metadata
        });

        await notification.save();

        // Invalidate unread counts
        if (recipient) {
            cacheDel(`unreadCount:${recipient}`).catch(() => {});
        } else {
            cacheInvalidatePattern('unreadCount:*').catch(() => {});
        }

        // Send Push Notification
        await sendTargetedNotification(target, targetId, {
            title,
            message,
            type,
            category,
            priority,
            actionType,
            actionData,
            metadata,
            _id: notification._id
        }, sendToPublic || false);

        res.status(201).json({ success: true, notification });
    } catch (err) {
        console.error('[Notification Controller] Send Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Get user notification preferences
 */
exports.getPreferences = async (req, res) => {
    try {
        let preferences = await NotificationPreference.findOne({ user: req.user.userId });

        if (!preferences) {
            // Create default preferences
            preferences = new NotificationPreference({ user: req.user.userId });
            await preferences.save();
        }

        res.json({ success: true, preferences });
    } catch (err) {
        console.error('[Notification Controller] Get Preferences Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Update notification preferences
 */
exports.updatePreferences = async (req, res) => {
    try {
        const updates = req.body;

        let preferences = await NotificationPreference.findOne({ user: req.user.userId });

        if (!preferences) {
            preferences = new NotificationPreference({ user: req.user.userId, ...updates });
        } else {
            Object.keys(updates).forEach(key => {
                preferences[key] = updates[key];
            });
        }

        await preferences.save();

        res.json({ success: true, preferences });
    } catch (err) {
        console.error('[Notification Controller] Update Preferences Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Helper to trigger internal notifications from other controllers.
 * Saves to DB and sends push notification with preference awareness.
 */
exports.triggerNotification = async (data) => {
    try {
        const { title, message, type, category, priority, target, targetId, actionType, actionData, metadata, recipient } = data;

        const notificationTitle = title ? title : 'New Notification';
        const notification = new Notification({
            title: notificationTitle,
            message,
            type: type || 'General',
            category: category || 'general',
            priority: priority || 'medium',
            recipient: recipient || (target === 'user' ? targetId : null),
            targetClass: target === 'class' ? targetId : null,
            targetRole: target !== 'user' && target !== 'class' ? target : (target === 'class' ? 'student' : 'all'),
            actionType: actionType || 'none',
            actionData,
            metadata
        });

        await notification.save();

        // Invalidate unread counts so badge updates immediately
        const targetRecipient = recipient || (target === 'user' ? targetId : null);
        if (targetRecipient) {
            cacheDel(`unreadCount:${targetRecipient}`).catch(() => {});
        } else {
            // Broadcast, class, or role notification: invalidate all unread counts
            cacheInvalidatePattern('unreadCount:*').catch(() => {});
        }

        // Push notification (preference-aware)
        await sendTargetedNotification(target, targetId, {
            title: notificationTitle,
            message,
            type: type || 'General',
            category: category || 'general',
            priority: priority || 'medium',
            actionType: actionType || 'none',
            actionData,
            metadata,
            _id: notification._id
        });

        return notification;
    } catch (error) {
        logger.error('[Notification Controller] Trigger Error:', error);
    }
};

/**
 * Manually trigger automated cron reminders (Admin only)
 */
exports.triggerCron = async (req, res) => {
    try {
        const { job = 'all-daily', force = false } = req.body || {};
        const {
            runAllDailyJobs,
            runBirthdayNotifications,
            runEventNotifications,
            runEventEveReminders,
            runExamDayReminders,
            runMonthlyFeeReminders,
            getCronLogs,
        } = require('../services/cronService');

        let result;
        if (job === 'birthday') {
            result = await runBirthdayNotifications({ trigger: 'manual', force });
        } else if (job === 'event') {
            result = await runEventNotifications({ trigger: 'manual', force });
        } else if (job === 'event-eve' || job === 'event_eve') {
            result = await runEventEveReminders({ trigger: 'manual', force });
        } else if (job === 'exam') {
            result = await runExamDayReminders({ trigger: 'manual', force });
        } else if (job === 'monthly-fee' || job === 'monthly_fee' || job === 'fee') {
            result = await runMonthlyFeeReminders({ trigger: 'manual', force });
        } else {
            result = await runAllDailyJobs({ trigger: 'manual', force });
        }

        const recentLogs = await getCronLogs({ limit: 10 });

        res.json({
            success: true,
            message: 'Cron job executed successfully',
            result,
            logs: recentLogs,
        });
    } catch (err) {
        logger.error('[Notification Controller] Trigger Cron Error:', err);
        res.status(500).json({ success: false, message: 'Failed to run cron job', error: err.message });
    }
};

/**
 * Fetch cron execution audit logs (Admin only)
 */
exports.getCronLogs = async (req, res) => {
    try {
        const { getCronLogs } = require('../services/cronService');
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const { jobName, status } = req.query;
        const logs = await getCronLogs({ limit, jobName, status });
        res.json({ success: true, logs });
    } catch (err) {
        logger.error('[Notification Controller] Get Cron Logs Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch cron logs', error: err.message });
    }
};


