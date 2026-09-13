const mongoose = require('mongoose');

/**
 * SyncLog — Audit trail for automated data syncs.
 * 
 * Tracks every fee sync attempt (success, partial, or failed) so admins
 * can review sync history and debug issues.
 */
const SyncLogSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['fee_sync', 'student_sync', 'staff_sync'],
        required: true,
        index: true
    },
    source: {
        type: String,
        enum: ['google_sheets', 'manual', 'cron', 'webhook', 'local_csv'],
        required: true
    },
    trigger: {
        type: String,
        enum: ['scheduled', 'on_demand', 'apps_script', 'manual'],
        default: 'on_demand'
    },
    status: {
        type: String,
        enum: ['success', 'partial', 'failed'],
        required: true
    },
    summary: {
        total: { type: Number, default: 0 },
        updated: { type: Number, default: 0 },
        created: { type: Number, default: 0 },
        failed: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 }
    },
    errors: [{
        row: Number,
        name: String,
        error: String
    }],
    durationMs: {
        type: Number
    },
    startedAt: {
        type: Date,
        required: true
    },
    completedAt: {
        type: Date
    }
}, {
    timestamps: true,
    suppressReservedKeysWarning: true
});

// Auto-cleanup: keep only last 90 days of sync logs
SyncLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('SyncLog', SyncLogSchema);
