const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const Notification = require('../models/Notification');
const logger = require('../utils/logger');
const {
    runBirthdayNotifications,
    runEventNotifications,
    runEventEveReminders,
    runExamDayReminders,
    runMonthlyFeeReminders,
    runStaleTokenCleanup,
    runNotificationCleanup,
} = require('../services/cronService');

// ─────────────────────────────────────────────────────────────
// Shared webhook secret middleware
// ─────────────────────────────────────────────────────────────

/**
 * Validates the x-cron-secret header against the CRON_SECRET env var.
 * Rejects requests when CRON_SECRET is not configured on the server.
 */
function validateCronSecret(req, res, next) {
    const secret = req.headers['x-cron-secret'];
    const validSecret = process.env.CRON_SECRET;

    if (!validSecret) {
        logger.error('[Webhook] CRON_SECRET environment variable is not set — all webhook calls rejected');
        return res.status(503).json({ success: false, message: 'Webhook secret not configured on server' });
    }

    if (secret !== validSecret) {
        logger.warn('[Webhook] Unauthorized cron webhook attempt blocked');
        return res.status(401).json({ success: false, message: 'Unauthorized webhook' });
    }

    next();
}

// Apply the middleware to all webhook routes
router.use(validateCronSecret);

// ─────────────────────────────────────────────────────────────
// Notification Cleanup
// ─────────────────────────────────────────────────────────────

// @route   POST /api/webhooks/cron/cleanup
// @desc    Clean old event notifications
// @access  Protected by CRON_SECRET
router.post('/cron/cleanup', async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const pastEvents = await Event.find({ date: { $lt: today } });

        if (pastEvents.length > 0) {
            const eventIds = pastEvents.map(event => event._id);
            const deleteResult = await Notification.deleteMany({ eventId: { $in: eventIds } });
            logger.info(`[Webhook] Cleaned ${deleteResult.deletedCount} notifications for past events`);
        } else {
            logger.info('[Webhook] No past events to clean up today');
        }

        res.json({ success: true, message: 'Event notification cleanup complete' });
    } catch (error) {
        logger.error('[Webhook] Cleanup error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────
// Birthday Notifications
// ─────────────────────────────────────────────────────────────

// @route   POST /api/webhooks/cron/birthday-notifications
// @desc    Trigger birthday notifications
// @access  Protected by CRON_SECRET
router.post('/cron/birthday-notifications', async (req, res) => {
    try {
        const result = await runBirthdayNotifications();

        if (result.skipped) {
            return res.json({ success: true, message: result.reason });
        }
        if (!result.sent) {
            return res.json({ success: true, message: result.reason });
        }

        res.json({
            success: true,
            message: `Birthday notifications sent for ${result.userCount} user(s)`,
            fcmResult: result.fcmResult,
        });
    } catch (error) {
        logger.error('[Webhook] Birthday error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────
// Event-Day Notifications
// ─────────────────────────────────────────────────────────────

// @route   POST /api/webhooks/cron/event-notifications
// @desc    Trigger event-day notifications
// @access  Protected by CRON_SECRET
router.post('/cron/event-notifications', async (req, res) => {
    try {
        const result = await runEventNotifications();

        if (!result.sent) {
            return res.json({ success: true, message: result.reason || 'No events today or all already notified' });
        }

        res.json({
            success: true,
            message: `Event notifications sent for ${result.sentCount} event(s) (${result.skippedCount} skipped)`,
        });
    } catch (error) {
        logger.error('[Webhook] Event notification error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────
// Event Eve Reminders
// ─────────────────────────────────────────────────────────────

// @route   POST /api/webhooks/cron/event-eve-reminders
// @desc    Trigger eve-of-event reminders for tomorrow's events
// @access  Protected by CRON_SECRET
router.post('/cron/event-eve-reminders', async (req, res) => {
    try {
        const result = await runEventEveReminders();

        if (!result.sent) {
            return res.json({ success: true, message: result.reason || 'No events tomorrow' });
        }

        res.json({
            success: true,
            message: `Eve reminders sent for ${result.sentCount} event(s)`,
        });
    } catch (error) {
        logger.error('[Webhook] Event eve reminder error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────
// Exam-Day Reminders
// ─────────────────────────────────────────────────────────────

// @route   POST /api/webhooks/cron/exam-reminders
// @desc    Trigger exam-day reminders for today's exams
// @access  Protected by CRON_SECRET
router.post('/cron/exam-reminders', async (req, res) => {
    try {
        const result = await runExamDayReminders();

        if (!result.sent) {
            return res.json({ success: true, message: result.reason || 'No exams today' });
        }

        res.json({
            success: true,
            message: `Exam reminders sent for ${result.sentCount} exam(s)`,
        });
    } catch (error) {
        logger.error('[Webhook] Exam reminder error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────
// Stale Token Cleanup
// ─────────────────────────────────────────────────────────────

// @route   POST /api/webhooks/cron/stale-token-cleanup
// @desc    Remove FCM tokens not updated in 60+ days
// @access  Protected by CRON_SECRET
router.post('/cron/stale-token-cleanup', async (req, res) => {
    try {
        const result = await runStaleTokenCleanup();

        res.json({
            success: true,
            message: `Removed ${result.deletedCount} stale FCM tokens`,
        });
    } catch (error) {
        logger.error('[Webhook] Stale token cleanup error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────
// Notification Retention Cleanup
// ─────────────────────────────────────────────────────────────

// @route   POST /api/webhooks/cron/notification-cleanup
// @desc    Archive old notifications (30d) and delete expired ones (90d)
// @access  Protected by CRON_SECRET
router.post('/cron/notification-cleanup', async (req, res) => {
    try {
        const result = await runNotificationCleanup();

        res.json({
            success: true,
            message: `Archived ${result.archivedCount}, deleted ${result.deletedCount} notifications`,
        });
    } catch (error) {
        logger.error('[Webhook] Notification cleanup error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// ─────────────────────────────────────────────────────────────
// Monthly Fee Reminders
// ─────────────────────────────────────────────────────────────

// @route   POST /api/webhooks/cron/monthly-fee-reminders
// @desc    Trigger monthly fee reminders for students with pending fees
// @access  Protected by CRON_SECRET
router.post('/cron/monthly-fee-reminders', async (req, res) => {
    try {
        const result = await runMonthlyFeeReminders();

        res.json({
            success: true,
            message: result.reason || `Monthly fee reminders sent to ${result.sentCount || 0} student(s)`,
            result,
        });
    } catch (error) {
        logger.error('[Webhook] Monthly fee reminder error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

module.exports = router;
