const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendTargetedNotification } = require('../services/notificationService');

/**
 * Get notifications for current user
 */
exports.getNotifications = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        let query = {
            $or: [
                { recipient: req.user.userId },
                {
                    recipient: null,
                    targetClass: null,
                    targetRole: { $in: ['all', req.user.role] }
                }
            ]
        };

        if (req.user.role === 'student') {
            const user = await User.findById(req.user.userId);
            if (user && user.currentClass) {
                query.$or.push({
                    recipient: null,
                    targetClass: user.currentClass
                });
            }
        }

        if (req.user.role === 'super admin') {
            query = {
                $or: [
                    { recipient: req.user.userId },
                    { recipient: null }
                ]
            };
        }

        const notifications = await Notification.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Notification.countDocuments(query);

        res.json({
            success: true,
            notifications,
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalNotifications: total
        });
    } catch (err) {
        console.error('[Notification Controller] Get Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Mark a single notification as read
 */
exports.markAsRead = async (req, res) => {
    try {
        const notification = await Notification.findById(req.params.id);
        if (!notification) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        // Only mark as read if it's a direct message to this user
        if (notification.recipient && notification.recipient.toString() === req.user.userId) {
            notification.read = true;
            await notification.save();
        }

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
        // Mark all direct notifications as read
        await Notification.updateMany(
            { recipient: req.user.userId, read: false },
            { $set: { read: true } }
        );

        res.json({ success: true, message: 'All notifications marked as read' });
    } catch (err) {
        console.error('[Notification Controller] Mark All Read Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Send a notification (Admin only)
 */
exports.sendNotification = async (req, res) => {
    try {
        const { title, message, type, target, targetId, metadata } = req.body;

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
        } else if (target === 'admin') {
            targetRole = 'admin';
        }

        const notification = new Notification({
            title,
            message,
            type: type || 'General',
            recipient,
            targetClass,
            targetRole,
            metadata
        });

        // Save to database (Fixed Bug)
        await notification.save();

        // Send Push Notification
        await sendTargetedNotification(target, targetId, {
            title,
            message,
            type
        });

        res.status(201).json({ success: true, notification });
    } catch (err) {
        console.error('[Notification Controller] Send Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Update notification preferences
 */
exports.updatePreferences = async (req, res) => {
    try {
        const { preferences } = req.body;
        const user = await User.findById(req.user.userId);

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (preferences) {
            user.notificationPreferences = {
                ...user.notificationPreferences,
                ...preferences
            };
            await user.save();
        }

        res.json({ success: true, preferences: user.notificationPreferences });
    } catch (err) {
        console.error('[Notification Controller] Update Pref Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

/**
 * Helper to trigger internal notifications from other controllers
 */
exports.triggerNotification = async (data) => {
    try {
        const { title, message, type, target, targetId, metadata, recipient } = data;

        const notification = new Notification({
            title,
            message,
            type: type || 'General',
            recipient: recipient || (target === 'user' ? targetId : null),
            targetClass: target === 'class' ? targetId : null,
            targetRole: target !== 'user' && target !== 'class' ? target : (target === 'class' ? 'student' : 'all'),
            metadata
        });

        await notification.save();

        // Push
        sendTargetedNotification(target, targetId, { title, message, type });

        return notification;
    } catch (error) {
        console.error('[Notification Controller] Trigger Error:', error.message);
    }
};
