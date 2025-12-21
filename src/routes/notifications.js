const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const notificationController = require('../controllers/notificationController');

// @route   GET /api/notifications
// @desc    Get current user's notifications
// @access  Private
router.get('/', auth, notificationController.getNotifications);

// @route   PUT /api/notifications/:id/read
// @desc    Mark notification as read
// @access  Private
router.put('/:id/read', auth, notificationController.markAsRead);

// @route   PUT /api/notifications/mark-all-read
// @desc    Mark all notifications as read
// @access  Private
router.put('/mark-all-read', auth, notificationController.markAllAsRead);

// @route   POST /api/notifications/send
// @desc    Send a notification (Admin only)
// @access  Private (Admin)
router.post('/send', auth, notificationController.sendNotification);

// @route   PUT /api/notifications/preferences
// @desc    Update notification preferences
// @access  Private
router.put('/preferences', auth, notificationController.updatePreferences);

module.exports = router;
