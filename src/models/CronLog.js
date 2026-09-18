const mongoose = require('mongoose');

/**
 * CronLog — Audit trail for automated & manual cron executions.
 * 
 * Records every execution of daily jobs (birthdays, events, exams, fees)
 * so admins can monitor runs, inspect results, and troubleshoot issues.
 */
const cronLogSchema = new mongoose.Schema({
    jobName: {
        type: String,
        enum: ['birthday', 'event', 'event_eve', 'exam', 'monthly_fee', 'stale_token', 'notification_cleanup', 'all_daily'],
        required: true,
        index: true,
    },
    trigger: {
        type: String,
        enum: ['scheduled', 'manual', 'webhook', 'catchup'],
        default: 'scheduled',
    },
    status: {
        type: String,
        enum: ['success', 'skipped', 'failed'],
        required: true,
    },
    message: {
        type: String,
        required: true,
    },
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
    },
    durationMs: {
        type: Number,
        default: 0,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
}, {
    timestamps: true,
});

// Auto-cleanup: keep logs for 30 days
cronLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('CronLog', cronLogSchema);
