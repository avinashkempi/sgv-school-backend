const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const Notification = require('../models/Notification');

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

module.exports = router;
