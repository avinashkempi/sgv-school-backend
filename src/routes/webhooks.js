const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const Notification = require('../models/Notification');
const { runBirthdayNotifications, runEventNotifications } = require('../services/cronService');

// @route   POST /api/webhooks/cron/cleanup
// @desc    Secure webhook for external cron services (Render Cron) to clean old notifications
// @access  Public (Protected by Secret Header)
router.post('/cron/cleanup', async (req, res) => {
    try {
        const secret = req.headers['x-cron-secret'];
        // Ideally process.env.CRON_SECRET is set in Render Dashboard
        const validSecret = process.env.CRON_SECRET || 'render-cron-secure-key-123';

        if (secret !== validSecret) {
            console.warn('⚠️ Unauthorized cron webhook attempt blocked.');
            return res.status(401).json({ success: false, message: 'Unauthorized webhook' });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const pastEvents = await Event.find({ date: { $lt: today } });

        if (pastEvents.length > 0) {
            const eventIds = pastEvents.map(event => event._id);
            const deleteResult = await Notification.deleteMany({ eventId: { $in: eventIds } });
            console.log(`🗑️ Webhook Executed: safely deleted ${deleteResult.deletedCount} notifications for past events`);
        } else {
            console.log('🗑️ Webhook Executed: No past events to cleanup today');
        }

        res.json({ success: true, message: 'Nightly cleanup finalized securely' });
    } catch (error) {
        console.error('❌ Webhook cleanup error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// @route   POST /api/webhooks/cron/birthday-notifications
// @desc    Secure webhook to trigger birthday notifications (Render Cron / manual trigger)
// @access  Public (Protected by Secret Header)
router.post('/cron/birthday-notifications', async (req, res) => {
    try {
        const secret = req.headers['x-cron-secret'];
        const validSecret = process.env.CRON_SECRET || 'render-cron-secure-key-123';

        if (secret !== validSecret) {
            console.warn('⚠️ Unauthorized birthday cron webhook attempt blocked.');
            return res.status(401).json({ success: false, message: 'Unauthorized webhook' });
        }

        const result = await runBirthdayNotifications();

        if (result.skipped) {
            return res.json({ success: true, message: result.reason });
        }
        if (!result.sent) {
            return res.json({ success: true, message: result.reason });
        }

        res.json({
            success: true,
            message: `Birthday notifications sent to ${result.userCount} user(s)`,
            fcmResult: result.fcmResult,
        });
    } catch (error) {
        console.error('❌ Birthday webhook error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// @route   POST /api/webhooks/cron/event-notifications
// @desc    Secure webhook to trigger event-day notifications (Render Cron / manual trigger)
// @access  Public (Protected by Secret Header)
router.post('/cron/event-notifications', async (req, res) => {
    try {
        const secret = req.headers['x-cron-secret'];
        const validSecret = process.env.CRON_SECRET || 'render-cron-secure-key-123';

        if (secret !== validSecret) {
            console.warn('⚠️ Unauthorized event cron webhook attempt blocked.');
            return res.status(401).json({ success: false, message: 'Unauthorized webhook' });
        }

        const result = await runEventNotifications();

        if (!result.sent) {
            return res.json({ success: true, message: result.reason || 'No events today or all already notified' });
        }

        res.json({
            success: true,
            message: `Event notifications sent for ${result.sentCount} event(s) (${result.skippedCount} skipped)`,
        });
    } catch (error) {
        console.error('❌ Event webhook error:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

module.exports = router;
