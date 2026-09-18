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
    runAllDailyJobs,
    getCronLogs,
} = require('../services/cronService');
const { runFeeSync, getSyncHistory } = require('../services/feeSyncService');

// ─────────────────────────────────────────────────────────────
// Shared webhook secret middleware
// ─────────────────────────────────────────────────────────────

/**
 * Validates the x-cron-secret header or secret query parameter against CRON_SECRET.
 * Rejects requests when CRON_SECRET is not configured on the server.
 */
function validateCronSecret(req, res, next) {
    const secret = req.headers['x-cron-secret'] || req.query.secret;
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
// @route   POST /api/webhooks/cron/birthdays (alias)
// @desc    Trigger birthday notifications
// @access  Protected by CRON_SECRET
const handleBirthdayWebhook = async (req, res) => {
    try {
        const force = req.query.force === 'true' || req.body?.force === true;
        const result = await runBirthdayNotifications({ trigger: 'webhook', force });

        if (result.skipped) {
            return res.json({ success: true, message: result.reason, result });
        }
        if (!result.sent) {
            return res.json({ success: true, message: result.reason, result });
        }

        res.json({
            success: true,
            message: `Birthday notifications sent for ${result.userCount} user(s)`,
            fcmResult: result.fcmResult,
            result,
        });
    } catch (error) {
        logger.error('[Webhook] Birthday error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

router.post('/cron/birthday-notifications', handleBirthdayWebhook);
router.post('/cron/birthdays', handleBirthdayWebhook);

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

// ─────────────────────────────────────────────────────────────
// Fee Sync from Google Sheets
// ─────────────────────────────────────────────────────────────

// @route   POST /api/webhooks/cron/fee-sync
// @desc    Trigger fee sync from Google Sheets (instant or scheduled)
// @access  Protected by CRON_SECRET
router.post('/cron/fee-sync', async (req, res) => {
    try {
        const dryRun = req.query.dryRun === 'true' || req.body.dryRun === true;
        const force = req.query.force === 'true' || req.body.force === true;

        // Determine trigger source
        let trigger = 'on_demand';
        if (req.headers['x-trigger-source'] === 'apps_script') {
            trigger = 'apps_script';
        } else if (req.headers['x-trigger-source'] === 'scheduled') {
            trigger = 'scheduled';
        }

        const result = await runFeeSync({ trigger, dryRun, force });

        if (result.skipped) {
            return res.json({
                success: true,
                message: result.reason || result.error || 'Fee sync skipped',
                skipped: true,
            });
        }

        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.error || 'Fee sync failed',
                syncLogId: result.syncLogId,
            });
        }

        res.json({
            success: true,
            message: `Fee sync completed — Updated: ${result.summary?.updated || 0}, Failed: ${result.summary?.failed || 0}`,
            ...(dryRun ? { dryRun: true, rowCount: result.rowCount, sampleHeaders: result.sampleHeaders } : {}),
            summary: result.summary,
            durationMs: result.durationMs,
            syncLogId: result.syncLogId,
        });
    } catch (error) {
        logger.error('[Webhook] Fee sync error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// @route   POST /api/webhooks/cron/all-daily
// @desc    Trigger all due daily cron jobs (morning/evening) in one unified request
// @access  Protected by CRON_SECRET
router.post('/cron/all-daily', async (req, res) => {
    try {
        const force = req.query.force === 'true' || req.body?.force === true;
        const results = await runAllDailyJobs({ trigger: 'webhook', force });
        res.json({
            success: true,
            message: 'All applicable daily cron jobs executed',
            results,
        });
    } catch (error) {
        logger.error('[Webhook] all-daily error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error', error: error.message });
    }
});

// @route   GET /api/webhooks/cron/logs
// @desc    Fetch recent cron execution audit logs
// @access  Protected by CRON_SECRET
router.get('/cron/logs', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
        const { jobName, status } = req.query;
        const logs = await getCronLogs({ limit, jobName, status });
        res.json({ success: true, logs });
    } catch (error) {
        logger.error('[Webhook] Cron logs error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// @route   GET /api/webhooks/cron/status
// @desc    Diagnostic endpoint to check cron system status & last activity
// @access  Protected by CRON_SECRET
router.get('/cron/status', async (req, res) => {
    try {
        const mongoose = require('mongoose');
        const now = new Date();
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const istNow = new Date(now.getTime() + IST_OFFSET_MS);

        // Fetch last 5 cron logs and last 5 cron notifications
        const [recentCronNotifications, recentCronLogs] = await Promise.all([
            Notification.find({
                category: { $in: ['birthday', 'event', 'exam', 'fee'] },
            })
                .sort({ createdAt: -1 })
                .limit(5)
                .select('title category createdAt metadata'),
            getCronLogs({ limit: 5 }),
        ]);

        res.json({
            success: true,
            serverTimeUTC: now.toISOString(),
            serverTimeIST: istNow.toISOString(),
            dbConnected: mongoose.connection.readyState === 1,
            feeSyncEnabled: process.env.FEE_SYNC_ENABLED === 'true',
            recentCronNotifications,
            recentCronLogs,
        });
    } catch (error) {
        logger.error('[Webhook] status error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// @route   GET /api/webhooks/sync-history
// @desc    Get recent fee sync history
// @access  Protected by CRON_SECRET
router.get('/sync-history', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const history = await getSyncHistory(limit);
        res.json({ success: true, history });
    } catch (error) {
        logger.error('[Webhook] Sync history error', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

module.exports = router;
