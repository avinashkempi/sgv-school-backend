const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const NotificationPreference = require('../models/NotificationPreference');
const User = require('../models/User');
const { sendTargetedNotification } = require('../services/notificationService');
const { cacheGet, cacheSet, cacheDel, cacheInvalidatePattern } = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Get notifications for current user with filtering
 */
exports.getNotifications = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        const { category, isRead, isArchived = 'false' } = req.query;

        let query = {
            isArchived: isArchived === 'true',
            $or: [
                { recipient: req.user.userId },
                {
                    recipient: null,
                    targetClass: null,
                    targetRole: { $in: ['all', req.user.role] }
                }
            ]
        };

        // Filter by category
        if (category && category !== 'all') {
            query.category = category;
        }

        // Filter by read status
        if (isRead !== undefined) {
            query.isRead = isRead === 'true';
        }

        if (req.user.role === 'student') {
            const currentClass = req.user.currentClass || (await User.findById(req.user.userId).select('currentClass').lean())?.currentClass;
            if (currentClass) {
                query.$or.push({
                    recipient: null,
                    targetClass: currentClass,
                    isArchived: isArchived === 'true'
                });
            }
        }

        if (req.user.role === 'super admin') {
            query = {
                isArchived: isArchived === 'true',
                $or: [
                    { recipient: req.user.userId },
                    { recipient: null }
                ]
            };
            if (category && category !== 'all') query.category = category;
            if (isRead !== undefined) query.isRead = isRead === 'true';
        }

        // Fetch paginated notifications and counts in parallel using aggregate
        const [notifications, countStats] = await Promise.all([
            Notification.find(query)
                .select('-actionData -metadata')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Notification.aggregate([
                { $match: query },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        unread: {
                            $sum: { $cond: [{ $eq: ['$isRead', false] }, 1, 0] }
                        }
                    }
                }
            ])
        ]);

        const total = countStats[0]?.total || 0;
        const unreadCount = countStats[0]?.unread || 0;

        res.json({
            success: true,
            notifications,
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
        const cacheKey = `unreadCount:${req.user.userId}`;

        // 1. Check Redis cache (30s TTL)
        try {
            const cachedCount = await cacheGet(cacheKey);
            if (cachedCount !== null && typeof cachedCount.unreadCount === 'number') {
                return res.json({ success: true, unreadCount: cachedCount.unreadCount });
            }
        } catch (_) {}

        const orClauses = [
            { recipient: req.user.userId },
            {
                recipient: null,
                targetClass: null,
                targetRole: { $in: ['all', req.user.role] }
            }
        ];

        // Students also receive class-broadcast notifications
        if (req.user.role === 'student') {
            const currentClass = req.user.currentClass || (await User.findById(req.user.userId).select('currentClass').lean())?.currentClass;
            if (currentClass) {
                orClauses.push({
                    recipient: null,
                    targetClass: currentClass,
                    isArchived: false
                });
            }
        }

        const query = { isRead: false, isArchived: false, $or: orClauses };
        const count = await Notification.countDocuments(query);

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
        
        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(notificationId)) {
            return res.status(400).json({ success: false, message: 'Invalid notification ID' });
        }
        
        const notification = await Notification.findById(notificationId);

        if (!notification) {
            // This is expected if notification was already deleted or marked read elsewhere
            // Only log as debug since this is a valid scenario (race condition or cleanup)
            console.debug(`[Notification Controller] Notification already deleted or not found (ID: ${notificationId})`);
            return res.status(404).json({ success: false, message: 'Notification not found or already deleted' });
        }

        // Only allow marking if this notification is addressed to the requesting user
        const isPersonal = notification.recipient?.toString() === req.user.userId;
        const isBroadcast = !notification.recipient;
        const isAdminOverride = req.user.role === 'admin' || req.user.role === 'super admin';
        if (!isPersonal && !isBroadcast && !isAdminOverride) {
            return res.status(403).json({ success: false, message: 'Not authorised to modify this notification' });
        }

        notification.isRead = isRead;
        notification.readAt = isRead ? new Date() : null;
        await notification.save();

        // Invalidate unread count cache for requesting user
        cacheDel(`unreadCount:${req.user.userId}`).catch(() => {});

        res.json({ success: true, notification });
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
        // Only mark notifications that are actually visible to this user:
        // - personally addressed ones, OR broadcast ones targeting their role
        const result = await Notification.updateMany(
            {
                isRead: false,
                isArchived: false,
                $or: [
                    { recipient: req.user.userId },
                    {
                        recipient: null,
                        targetClass: null,
                        targetRole: { $in: ['all', req.user.role] }
                    }
                ]
            },
            { $set: { isRead: true, readAt: new Date() } }
        );

        // Invalidate unread count cache
        cacheDel(`unreadCount:${req.user.userId}`).catch(() => {});

        res.json({
            success: true,
            message: 'All notifications marked as read',
            modifiedCount: result.modifiedCount
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
            priority
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

        // Push notification (preference-aware)
        await sendTargetedNotification(target, targetId, {
            title: notificationTitle,
            message,
            type: type || 'General',
            category: category || 'general',
            priority: priority || 'medium',
        });

        return notification;
    } catch (error) {
        logger.error('[Notification Controller] Trigger Error:', error);
    }
};

