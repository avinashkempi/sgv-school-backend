const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const notificationController = require('../controllers/notificationController');

// @route   GET /api/notifications
// @desc    Get current user's notifications (with filtering)
// @access  Private
router.get('/', auth, notificationController.getNotifications);

// @route   GET /api/notifications/unread-count
// @desc    Get unread notification count
// @access  Private
router.get('/unread-count', auth, notificationController.getUnreadCount);

// @route   GET /api/notifications/preferences
// @desc    Get notification preferences
// @access  Private
router.get('/preferences', auth, notificationController.getPreferences);

// @route   PUT /api/notifications/:id/read
// @desc    Mark notification as read/unread
// @access  Private
router.put('/:id/read', auth, notificationController.markAsRead);

// @route   PUT /api/notifications/:id/archive
// @desc    Archive/unarchive notification
// @access  Private
router.put('/:id/archive', auth, notificationController.archiveNotification);

// @route   DELETE /api/notifications/:id
// @desc    Delete notification (admin only)
// @access  Private (Admin)
router.delete('/:id', auth, notificationController.deleteNotification);

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
