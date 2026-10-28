const mongoose = require('mongoose');

/**
 * AuditLog — Persistent audit trail for sensitive administrative actions.
 * 
 * Records mutations to classes, user roles, academic years, and system configs
 * to provide non-repudiation, accountability, and traceability.
 */
const auditLogSchema = new mongoose.Schema({
    actor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    actorName: {
        type: String,
        trim: true
    },
    actorRole: {
        type: String,
        required: true
    },
    action: {
        type: String,
        required: true,
        index: true // e.g., 'CLASS_UPDATED', 'CLASS_CREATED', 'CLASS_DELETED'
    },
    entityType: {
        type: String,
        required: true,
        index: true // e.g., 'Class', 'User', 'AcademicYear'
    },
    entityId: {
        type: mongoose.Schema.Types.ObjectId,
        index: true
    },
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    ip: {
        type: String,
        trim: true
    },
    userAgent: {
        type: String,
        trim: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Auto-cleanup: keep audit logs for 90 days
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
