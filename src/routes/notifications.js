const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { sendTargetedNotification } = require('../services/notificationService');

// @route   GET /api/notifications
// @desc    Get current user's notifications
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        // Find notifications where:
        // 1. Recipient is the user
        // 2. OR Recipient is null AND (targetClass is null OR targetClass is user's class)
        // 3. OR targetRole matches user's role OR targetRole is 'all'
        // AND createdAt is within reasonable time (e.g., last 30 days) - Optional optimization

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

        // If user is a student, include class-specific notifications
        if (req.user.role === 'student') {
            const user = await User.findById(req.user.userId);
            if (user && user.currentClass) {
                query.$or.push({
                    recipient: null,
                    targetClass: user.currentClass
                });
            }
        }

        // Super Admin sees all broadcasts
        if (req.user.role === 'super admin') {
            query = {
                $or: [
                    { recipient: req.user.userId },
                    { recipient: null } // See all broadcasts
                ]
            };
        }

        const notifications = await Notification.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Notification.countDocuments(query);

        res.json({
            notifications,
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalNotifications: total
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/notifications/:id/read
// @desc    Mark notification as read
// @access  Private
router.put('/:id/read', auth, async (req, res) => {
    try {
        // For broadcast messages, we can't easily mark as read for individual users without a separate "UserNotifications" table.
        // For now, we'll assume this only works for individual messages OR we just don't track read status for broadcasts strictly on backend yet.
        // OR we can update the 'read' status if it's a direct message.

        // A better approach for broadcasts is to store "readBy" array, but that scales poorly.
        // For MVP, we will only update if recipient == user. 
        // If it's a broadcast, we might need to handle it differently (e.g. client-side storage of read IDs).

        let notification = await Notification.findById(req.params.id);
        if (!notification) return res.status(404).json({ msg: 'Notification not found' });

        if (notification.recipient && notification.recipient.toString() === req.user.userId) {
            notification.read = true;
            await notification.save();
        }

        // For broadcasts, we just return success, client handles UI state.
        res.json(notification);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/notifications/send
// @desc    Send a notification (Admin only)
// @access  Private (Admin)
router.post('/send', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (user.role !== 'admin' && user.role !== 'super admin') {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        const { title, message, type, target, targetId } = req.body;
        // target: 'all', 'class', 'user', 'teacher', 'staff'

        let recipient = null;
        let targetClass = null;
        let targetRole = 'all';

        if (target === 'user') {
            recipient = targetId;
        } else if (target === 'class') {
            targetClass = targetId;
            targetRole = 'student'; // Implicitly for students of that class
        } else if (target === 'teacher') {
            targetRole = 'teacher';
        } else if (target === 'staff') {
            targetRole = 'staff';
        }

        const notification = new Notification({
            title,
            message,
            type: type || 'General',
            recipient,
            targetClass,
            targetRole
        });

        // Send push notification
        await sendTargetedNotification(target, targetId, {
            title,
            message,
            type
        });

        res.json(notification);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/notifications/preferences
// @desc    Update notification preferences
// @access  Private
router.put('/preferences', auth, async (req, res) => {
    try {
        const { preferences } = req.body;
        const user = await User.findById(req.user.userId);

        if (preferences) {
            user.notificationPreferences = {
                ...user.notificationPreferences,
                ...preferences
            };
            await user.save();
        }

        res.json(user.notificationPreferences);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
