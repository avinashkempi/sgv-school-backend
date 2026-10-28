const AuditLog = require('../models/AuditLog');
const logger = require('./logger');

/**
 * Persist an audit log entry for administrative mutations.
 * 
 * @param {Object} options
 * @param {Object} options.req - Express request object containing actor context and client info
 * @param {string} options.action - Action identifier (e.g., 'CLASS_UPDATED', 'CLASS_DELETED')
 * @param {string} options.entityType - Type of modified entity (e.g., 'Class')
 * @param {string|mongoose.Types.ObjectId} [options.entityId] - Target entity ID
 * @param {Object} [options.details={}] - Diff or contextual parameters
 */
const logAudit = async ({ req, action, entityType, entityId, details = {} }) => {
    try {
        const actorId = req.user?.userId || req.user?.id || req.user?._id;
        const actorName = req.user?.name || 'Unknown';
        const actorRole = req.user?.role || 'Unknown';
        const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || 'Unknown';
        const userAgent = req.headers['user-agent'] || 'Unknown';

        if (!actorId) {
            logger.warn(`[AuditLog] Skipping audit log for ${action}: unauthenticated request`);
            return;
        }

        await AuditLog.create({
            actor: actorId,
            actorName,
            actorRole,
            action,
            entityType,
            entityId,
            details,
            ip: clientIp,
            userAgent
        });

        logger.info(`[AuditLog] ${action} on ${entityType}:${entityId} by ${actorName} (${actorRole})`);
    } catch (err) {
        logger.error(`[AuditLog] Failed to persist audit log for ${action}:`, err);
    }
};

module.exports = { logAudit };
