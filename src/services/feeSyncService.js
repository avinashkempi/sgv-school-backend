const { fetchSheetData, isConfigured } = require('./googleSheetsService');
const { processImport } = require('./importService');
const { sendTargetedNotification } = require('./notificationService');
const SyncLog = require('../models/SyncLog');
const AcademicYear = require('../models/AcademicYear');
const logger = require('../utils/logger');

/**
 * Fee Sync Service
 * 
 * Orchestrates the full automated fee sync pipeline:
 * 1. Fetch latest data from Google Sheets
 * 2. Run processImport with feesOnly=true
 * 3. Log results to SyncLog
 * 4. Notify admins with a summary
 */

// Minimum interval between syncs (in ms) to prevent duplicate/spam syncs
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a sync ran too recently (debounce).
 * @returns {Promise<boolean>} true if should skip
 */
async function shouldSkipSync() {
    const recentSync = await SyncLog.findOne({
        type: 'fee_sync',
        source: 'google_sheets',
        status: { $in: ['success', 'partial'] },
        completedAt: { $gte: new Date(Date.now() - MIN_SYNC_INTERVAL_MS) }
    }).lean();

    return !!recentSync;
}

/**
 * Run the full fee sync from Google Sheets.
 * 
 * @param {Object} options
 * @param {string} [options.trigger='on_demand'] - What triggered this sync
 * @param {boolean} [options.dryRun=false] - If true, fetch data but don't write to DB
 * @param {boolean} [options.force=false] - If true, skip the debounce check
 * @returns {Promise<Object>} Sync result
 */
async function runFeeSync(options = {}) {
    const { trigger = 'on_demand', dryRun = false, force = false } = options;
    const startedAt = new Date();

    logger.info(`[FeeSync] Starting fee sync (trigger: ${trigger}, dryRun: ${dryRun})`);

    // Check configuration
    const config = isConfigured();
    if (!config.configured) {
        logger.error(`[FeeSync] Not configured: ${config.reason}`);
        return {
            success: false,
            error: `Google Sheets not configured: ${config.reason}`,
            skipped: true
        };
    }

    // Check if sync is enabled
    if (process.env.FEE_SYNC_ENABLED !== 'true') {
        logger.info('[FeeSync] Fee sync is disabled (FEE_SYNC_ENABLED !== true)');
        return {
            success: false,
            error: 'Fee sync is disabled',
            skipped: true
        };
    }

    // Debounce check (unless forced)
    if (!force && !dryRun) {
        const skip = await shouldSkipSync();
        if (skip) {
            logger.info('[FeeSync] Skipping — a sync completed within the last 5 minutes');
            return {
                success: true,
                skipped: true,
                reason: 'Sync completed recently (within 5 minutes). Use force=true to override.'
            };
        }
    }

    // Create sync log entry
    const syncLog = new SyncLog({
        type: 'fee_sync',
        source: 'google_sheets',
        trigger,
        status: 'failed', // Will update on success
        startedAt
    });

    try {
        // Step 1: Fetch data from Google Sheets
        logger.info('[FeeSync] Step 1/4: Fetching data from Google Sheets...');
        const sheetData = await fetchSheetData();

        if (!sheetData || sheetData.length === 0) {
            syncLog.status = 'failed';
            syncLog.summary = { total: 0, updated: 0, failed: 0 };
            syncLog.completedAt = new Date();
            syncLog.durationMs = Date.now() - startedAt.getTime();
            await syncLog.save();

            logger.warn('[FeeSync] No data found in Google Sheet');
            return {
                success: false,
                error: 'No data found in Google Sheet',
                summary: { total: 0 }
            };
        }

        logger.info(`[FeeSync] Step 2/4: Fetched ${sheetData.length} rows from Google Sheets`);

        // Dry run — return data without writing
        if (dryRun) {
            logger.info(`[FeeSync] Dry run complete — ${sheetData.length} rows would be processed`);
            return {
                success: true,
                dryRun: true,
                rowCount: sheetData.length,
                sampleHeaders: Object.keys(sheetData[0]),
                sampleRow: sheetData[0]
            };
        }

        // Step 2: Resolve active academic year
        const academicYear = await AcademicYear.findOne({ isActive: true });
        const academicYearId = academicYear?._id;

        // Step 3: Run processImport with feesOnly=true
        logger.info('[FeeSync] Step 3/4: Running fee import (feesOnly mode)...');
        const importResult = await processImport(sheetData, {
            feesOnly: true,
            academicYearId
        });

        // Step 4: Log results
        const completedAt = new Date();
        const durationMs = completedAt.getTime() - startedAt.getTime();

        syncLog.status = importResult.failed > 0 ? 'partial' : 'success';
        syncLog.summary = {
            total: importResult.total,
            updated: importResult.updated,
            created: importResult.created,
            failed: importResult.failed,
            skipped: 0
        };
        syncLog.errors = (importResult.errors || []).slice(0, 50); // Cap at 50 errors
        syncLog.completedAt = completedAt;
        syncLog.durationMs = durationMs;
        await syncLog.save();

        logger.info(
            `[FeeSync] Step 4/4: Sync complete in ${durationMs}ms — ` +
            `Total: ${importResult.total}, Updated: ${importResult.updated}, ` +
            `Failed: ${importResult.failed}`
        );

        // Notify admins
        await notifyAdmins(importResult, trigger, durationMs);

        return {
            success: true,
            summary: {
                total: importResult.total,
                updated: importResult.updated,
                created: importResult.created,
                failed: importResult.failed,
                errors: importResult.errors
            },
            durationMs,
            syncLogId: syncLog._id
        };

    } catch (error) {
        const completedAt = new Date();
        syncLog.status = 'failed';
        syncLog.errors = [{ error: error.message }];
        syncLog.completedAt = completedAt;
        syncLog.durationMs = completedAt.getTime() - startedAt.getTime();
        await syncLog.save().catch(err => logger.error('[FeeSync] Failed to save error log', err));

        logger.error('[FeeSync] Fatal error during sync', error);

        // Notify admins about failure
        try {
            await sendTargetedNotification('admin', null, {
                title: '❌ Fee Sync Failed',
                message: `Automated fee sync failed: ${error.message}. Check server logs.`,
                type: 'System',
                category: 'system',
                priority: 'high'
            }, false);
        } catch (notifErr) {
            logger.error('[FeeSync] Failed to send error notification', notifErr);
        }

        return {
            success: false,
            error: error.message,
            syncLogId: syncLog._id
        };
    }
}

/**
 * Send a push notification to admins summarizing the sync result.
 */
async function notifyAdmins(importResult, trigger, durationMs) {
    try {
        const triggerLabel = {
            scheduled: '⏰ Scheduled',
            on_demand: '🔄 On-demand',
            apps_script: '📊 Sheet edit',
            manual: '👤 Manual'
        }[trigger] || trigger;

        const seconds = (durationMs / 1000).toFixed(1);
        const title = importResult.failed > 0
            ? '⚠️ Fee Sync Completed (with errors)'
            : '✅ Fee Sync Completed';

        const message =
            `${triggerLabel} sync finished in ${seconds}s. ` +
            `Updated: ${importResult.updated} students. ` +
            (importResult.failed > 0 ? `Failed: ${importResult.failed}. ` : '') +
            `Total: ${importResult.total} rows.`;

        await sendTargetedNotification('admin', null, {
            title,
            message,
            type: 'System',
            category: 'system',
            priority: importResult.failed > 0 ? 'high' : 'low'
        }, false);

    } catch (error) {
        // Non-critical — don't throw if notification fails
        logger.error('[FeeSync] Failed to send admin notification', error);
    }
}

/**
 * Get recent sync history for admin dashboard.
 * @param {number} [limit=20]
 * @returns {Promise<Array>}
 */
async function getSyncHistory(limit = 20) {
    return SyncLog.find({ type: 'fee_sync' })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
}

module.exports = { runFeeSync, getSyncHistory };
