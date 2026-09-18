const cron = require('node-cron');
const User = require('../models/User');
const Event = require('../models/Event');
const Exam = require('../models/Exam');
const Notification = require('../models/Notification');
const FCMToken = require('../models/FCMToken');
const FeeStructure = require('../models/FeeStructure');
const FeePayment = require('../models/FeePayment');
const StudentFee = require('../models/StudentFee');
const AcademicYear = require('../models/AcademicYear');
const CronLog = require('../models/CronLog');
const { sendTargetedNotification } = require('./notificationService');
const logger = require('../utils/logger');
const toTitleCase = require('../utils/titleCase');
const { runFeeSync } = require('./feeSyncService');

// ─────────────────────────────────────────────────────────────
// Helpers & Audit Logging
// ─────────────────────────────────────────────────────────────

/**
 * Record a persistent audit log entry in MongoDB for any cron execution.
 */
async function recordCronLog({ jobName, trigger = 'scheduled', status, message, details = {}, durationMs = 0 }) {
    try {
        await CronLog.create({
            jobName,
            trigger,
            status,
            message,
            details,
            durationMs,
        });
    } catch (err) {
        logger.error(`[CronLog] Failed to persist log for ${jobName}:`, err);
    }
}

/**
 * Fetch recent cron logs from MongoDB with optional filtering.
 */
async function getCronLogs(options = {}) {
    const { limit = 50, jobName, status } = options;
    const filter = {};
    if (jobName && jobName !== 'all') filter.jobName = jobName;
    if (status && status !== 'all') filter.status = status;
    return CronLog.find(filter)
        .sort({ createdAt: -1 })
        .limit(Math.min(parseInt(limit, 10) || 50, 100))
        .lean();
}

/** Return { startOfDay, endOfDay } in UTC for the current IST date. */
function getISTDayBounds() {
    // IST = UTC+5:30 → offset in ms
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowUTC = Date.now();
    const istNow = new Date(nowUTC + IST_OFFSET_MS);

    const startOfDay = new Date(Date.UTC(
        istNow.getUTCFullYear(),
        istNow.getUTCMonth(),
        istNow.getUTCDate(),
        0, 0, 0, 0
    ));
    startOfDay.setTime(startOfDay.getTime() - IST_OFFSET_MS); // convert back to UTC

    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    return { startOfDay, endOfDay };
}

/** Return { startOfDay, endOfDay } in UTC for *tomorrow* in IST. */
function getISTTomorrowBounds() {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowUTC = Date.now();
    const istNow = new Date(nowUTC + IST_OFFSET_MS);

    const tomorrow = new Date(Date.UTC(
        istNow.getUTCFullYear(),
        istNow.getUTCMonth(),
        istNow.getUTCDate() + 1,
        0, 0, 0, 0
    ));
    tomorrow.setTime(tomorrow.getTime() - IST_OFFSET_MS);

    const endOfTomorrow = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000 - 1);

    return { startOfDay: tomorrow, endOfDay: endOfTomorrow };
}

/** Get current IST hour (0-23) reliably using offset math. */
function getISTHour() {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    return istNow.getUTCHours();
}

/** Get current IST day of month (1-31) reliably using offset math. */
function getISTDate() {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    return istNow.getUTCDate();
}

/** Get current IST date components reliably using offset math. */
function getISTDateComponents() {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    return {
        year: istNow.getUTCFullYear(),
        month: istNow.getUTCMonth() + 1,
        day: istNow.getUTCDate(),
    };
}

/** Format a Date object into a readable string like "15 Aug 2026" */
function formatDate(date) {
    const d = new Date(date);
    return d.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
    });
}

// ─────────────────────────────────────────────────────────────
// 1. Birthday Notifications (Daily at 08:00 AM IST)
// ─────────────────────────────────────────────────────────────

async function runBirthdayNotifications(options = {}) {
    const { trigger = 'scheduled', force = false } = options;
    const startTime = Date.now();
    try {
        const { month: todayMonth, day: todayDay } = getISTDateComponents();

        logger.info(`[Birthday Cron] Running check for ${todayDay}/${todayMonth} (IST) [trigger: ${trigger}, force: ${force}]`);

        const { startOfDay, endOfDay } = getISTDayBounds();

        // Duplicate guard (can be bypassed if force = true)
        const alreadySent = await Notification.findOne({
            category: 'birthday',
            createdAt: { $gte: startOfDay, $lte: endOfDay },
        });

        if (alreadySent && !force) {
            const durationMs = Date.now() - startTime;
            logger.info(`[Birthday Cron] Already sent today (${todayDay}/${todayMonth}) — skipping`);
            await recordCronLog({
                jobName: 'birthday',
                trigger,
                status: 'skipped',
                message: `Birthday notifications already sent today (${todayDay}/${todayMonth} IST)`,
                details: { existingNotificationId: alreadySent._id, title: alreadySent.title },
                durationMs,
            });
            return { skipped: true, reason: 'Already sent today', checkedDate: `${todayDay}/${todayMonth}` };
        }

        // Find users with a birthday today
        // Note: No isActive dependency as per requirement - all users with matching dateOfBirth are included
        const birthdayUsers = await User.find({
            dateOfBirth: { $exists: true, $ne: null },
            $expr: {
                $or: [
                    // Match with Asia/Kolkata timezone (handles dates stored with IST midnight offset)
                    {
                        $and: [
                            { $eq: [{ $month: { date: '$dateOfBirth', timezone: 'Asia/Kolkata' } }, todayMonth] },
                            { $eq: [{ $dayOfMonth: { date: '$dateOfBirth', timezone: 'Asia/Kolkata' } }, todayDay] },
                        ],
                    },
                    // Fallback to UTC match (handles dates stored as UTC date-only strings)
                    {
                        $and: [
                            { $eq: [{ $month: '$dateOfBirth' }, todayMonth] },
                            { $eq: [{ $dayOfMonth: '$dateOfBirth' }, todayDay] },
                        ],
                    },
                ],
            },
        }).select('name role dateOfBirth');

        const durationMs = Date.now() - startTime;

        if (birthdayUsers.length === 0) {
            logger.info(`[Birthday Cron] No birthdays today (${todayDay}/${todayMonth})`);
            await recordCronLog({
                jobName: 'birthday',
                trigger,
                status: 'success',
                message: `Checked birthdays for ${todayDay}/${todayMonth} (IST): 0 birthdays found`,
                details: { checkedDate: `${todayDay}/${todayMonth}`, birthdayCount: 0 },
                durationMs,
            });
            return { sent: false, userCount: 0, reason: `No birthdays today (${todayDay}/${todayMonth})` };
        }

        const names = birthdayUsers.map(u => toTitleCase(u.name));
        const namesList = names.join(', ');
        const title = '🎂 Happy Birthday!';
        const message =
            birthdayUsers.length === 1
                ? `Wishing ${names[0]} a very Happy Birthday! 🎉🥳`
                : `Today we celebrate the birthdays of ${namesList}! 🎉🥳 Wish them a wonderful day!`;

        const result = await sendTargetedNotification(
            'all',
            null,
            { title, message, type: 'Birthday', category: 'birthday' },
            true, // Send to all registered devices (both authenticated and public/guest)
        );

        await Notification.create({
            title,
            message,
            type: 'Birthday',
            category: 'birthday',
            priority: 'medium',
            recipient: null,
            targetRole: 'all',
            sendToPublic: true,
            metadata: {
                birthdayUserIds: birthdayUsers.map(u => u._id.toString()),
                birthdayUserNames: names,
            },
        });

        const totalDurationMs = Date.now() - startTime;
        logger.info(`[Birthday Cron] Sent for ${birthdayUsers.length} user(s): ${namesList}`);
        await recordCronLog({
            jobName: 'birthday',
            trigger,
            status: 'success',
            message: `Sent birthday greetings for ${birthdayUsers.length} user(s): ${namesList}`,
            details: {
                userCount: birthdayUsers.length,
                names,
                fcmResult: result,
            },
            durationMs: totalDurationMs,
        });

        return { sent: true, userCount: birthdayUsers.length, names, fcmResult: result };
    } catch (error) {
        logger.error('[Birthday Cron] Error running birthday notifications', error);
        await recordCronLog({
            jobName: 'birthday',
            trigger,
            status: 'failed',
            message: error.message,
            details: { stack: error.stack },
            durationMs: Date.now() - startTime,
        });
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────
// 2. Event-Day Notifications (Daily at 08:00 AM IST)
// ─────────────────────────────────────────────────────────────

async function runEventNotifications(options = {}) {
    const { trigger = 'scheduled', force = false } = options;
    const startTime = Date.now();
    try {
        const { startOfDay, endOfDay } = getISTDayBounds();

        logger.info(`[Event Cron] Checking for events on ${formatDate(startOfDay)} [trigger: ${trigger}, force: ${force}]`);

        const todayEvents = await Event.find({
            date: { $gte: startOfDay, $lte: endOfDay },
        }).select('title description _id isHoliday');

        if (todayEvents.length === 0) {
            const durationMs = Date.now() - startTime;
            logger.info('[Event Cron] No events today');
            await recordCronLog({
                jobName: 'event',
                trigger,
                status: 'success',
                message: `Checked events for ${formatDate(startOfDay)}: 0 events found`,
                details: { eventCount: 0 },
                durationMs,
            });
            return { sent: false, reason: 'No events today' };
        }

        let sentCount = 0;
        let skippedCount = 0;

        for (const event of todayEvents) {
            // Per-event duplicate guard
            const alreadySent = await Notification.findOne({
                category: 'event',
                eventId: event._id,
                createdAt: { $gte: startOfDay, $lte: endOfDay },
                'metadata.reminderType': { $ne: 'eve' },
            });

            if (alreadySent && !force) {
                logger.info(`[Event Cron] Already notified for "${event.title}" — skipping`);
                skippedCount++;
                continue;
            }

            const emoji = event.isHoliday ? '🏖️' : '📅';
            const title = `${emoji} Today: ${event.title}`;
            const message = event.description
                ? event.description.substring(0, 150)
                : `Reminder — "${event.title}" is happening today!`;

            await sendTargetedNotification(
                'all',
                null,
                { title, message, type: 'Event', category: 'event' },
                false,
            );

            await Notification.create({
                title,
                message,
                type: 'Event',
                category: 'event',
                priority: 'medium',
                recipient: null,
                targetRole: 'all',
                sendToPublic: false,
                eventId: event._id,
                metadata: { eventTitle: event.title, reminderType: 'day-of' },
            });

            logger.info(`[Event Cron] Sent day-of notification for: "${event.title}"`);
            sentCount++;
        }

        const durationMs = Date.now() - startTime;
        await recordCronLog({
            jobName: 'event',
            trigger,
            status: 'success',
            message: `Processed ${todayEvents.length} event(s): sent ${sentCount}, skipped ${skippedCount}`,
            details: { totalEvents: todayEvents.length, sentCount, skippedCount },
            durationMs,
        });

        return { sent: sentCount > 0, sentCount, skippedCount, totalEvents: todayEvents.length };
    } catch (error) {
        logger.error('[Event Cron] Error running event notifications', error);
        await recordCronLog({
            jobName: 'event',
            trigger,
            status: 'failed',
            message: error.message,
            details: { stack: error.stack },
            durationMs: Date.now() - startTime,
        });
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────
// 3. Event Eve Reminders (Daily at 08:00 PM IST)
// ─────────────────────────────────────────────────────────────

async function runEventEveReminders(options = {}) {
    const { trigger = 'scheduled', force = false } = options;
    const startTime = Date.now();
    try {
        const { startOfDay, endOfDay } = getISTTomorrowBounds();

        logger.info(`[Event Eve Cron] Checking for events tomorrow: ${formatDate(startOfDay)} [trigger: ${trigger}]`);

        const tomorrowEvents = await Event.find({
            date: { $gte: startOfDay, $lte: endOfDay },
        }).select('title description _id isHoliday');

        if (tomorrowEvents.length === 0) {
            const durationMs = Date.now() - startTime;
            logger.info('[Event Eve Cron] No events tomorrow');
            await recordCronLog({
                jobName: 'event_eve',
                trigger,
                status: 'success',
                message: `Checked eve reminders for tomorrow (${formatDate(startOfDay)}): 0 events found`,
                details: { eventCount: 0 },
                durationMs,
            });
            return { sent: false, reason: 'No events tomorrow' };
        }

        let sentCount = 0;
        let skippedCount = 0;
        const { startOfDay: todayStart, endOfDay: todayEnd } = getISTDayBounds();

        for (const event of tomorrowEvents) {
            // Duplicate guard — check if eve reminder already sent today for this event
            const alreadySent = await Notification.findOne({
                category: 'event',
                eventId: event._id,
                'metadata.reminderType': 'eve',
                createdAt: { $gte: todayStart, $lte: todayEnd },
            });

            if (alreadySent && !force) {
                logger.info(`[Event Eve Cron] Eve reminder already sent for "${event.title}" — skipping`);
                skippedCount++;
                continue;
            }

            const emoji = event.isHoliday ? '🏖️' : '🔔';
            const title = `${emoji} Tomorrow: ${event.title}`;
            const message = event.description
                ? `Heads up! "${event.title}" is scheduled for tomorrow. ${event.description.substring(0, 100)}`
                : `Heads up! "${event.title}" is scheduled for tomorrow. Don't forget to prepare!`;

            await sendTargetedNotification(
                'all',
                null,
                { title, message, type: 'Event', category: 'event' },
                false,
            );

            await Notification.create({
                title,
                message,
                type: 'Event',
                category: 'event',
                priority: 'low',
                recipient: null,
                targetRole: 'all',
                sendToPublic: false,
                eventId: event._id,
                metadata: { eventTitle: event.title, reminderType: 'eve' },
            });

            logger.info(`[Event Eve Cron] Sent eve reminder for: "${event.title}"`);
            sentCount++;
        }

        const durationMs = Date.now() - startTime;
        await recordCronLog({
            jobName: 'event_eve',
            trigger,
            status: 'success',
            message: `Processed ${tomorrowEvents.length} eve event(s): sent ${sentCount}, skipped ${skippedCount}`,
            details: { totalEvents: tomorrowEvents.length, sentCount, skippedCount },
            durationMs,
        });

        return { sent: sentCount > 0, sentCount, skippedCount, totalEvents: tomorrowEvents.length };
    } catch (error) {
        logger.error('[Event Eve Cron] Error', error);
        await recordCronLog({
            jobName: 'event_eve',
            trigger,
            status: 'failed',
            message: error.message,
            details: { stack: error.stack },
            durationMs: Date.now() - startTime,
        });
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────
// 4. Exam-Day Reminders (Daily at 07:00 AM IST)
// ─────────────────────────────────────────────────────────────

async function runExamDayReminders(options = {}) {
    const { trigger = 'scheduled', force = false } = options;
    const startTime = Date.now();
    try {
        const { startOfDay, endOfDay } = getISTDayBounds();

        logger.info(`[Exam Cron] Checking for exams on ${formatDate(startOfDay)} [trigger: ${trigger}]`);

        const todayExams = await Exam.find({
            date: { $gte: startOfDay, $lte: endOfDay },
            status: { $in: ['scheduled', 'ongoing'] },
        }).populate('subject', 'name').populate('class', 'name');

        if (todayExams.length === 0) {
            const durationMs = Date.now() - startTime;
            logger.info('[Exam Cron] No exams today');
            await recordCronLog({
                jobName: 'exam',
                trigger,
                status: 'success',
                message: `Checked exams for ${formatDate(startOfDay)}: 0 exams found`,
                details: { examCount: 0 },
                durationMs,
            });
            return { sent: false, reason: 'No exams today' };
        }

        let sentCount = 0;
        let skippedCount = 0;

        for (const exam of todayExams) {
            // Duplicate guard
            const alreadySent = await Notification.findOne({
                category: 'exam',
                'metadata.examId': exam._id.toString(),
                'metadata.reminderType': 'exam-day',
                createdAt: { $gte: startOfDay, $lte: endOfDay },
            });

            if (alreadySent && !force) {
                logger.info(`[Exam Cron] Already notified for "${exam.name}" — skipping`);
                skippedCount++;
                continue;
            }

            const subjectName = exam.subject?.name || 'Unknown Subject';
            const className = exam.class?.name || '';
            const timeInfo = exam.startTime ? ` at ${exam.startTime}` : '';
            const roomInfo = exam.room ? ` in ${exam.room}` : '';

            const title = `📝 Exam Today: ${subjectName}`;
            const message = `Your ${exam.name} for ${subjectName} is today${timeInfo}${roomInfo}. Best of luck! 💪`;

            // Send only to students of that class
            await sendTargetedNotification(
                'class',
                exam.class?._id,
                { title, message, type: 'Exam', category: 'exam' },
                false,
            );

            await Notification.create({
                title,
                message,
                type: 'Exam',
                category: 'exam',
                priority: 'high',
                recipient: null,
                targetClass: exam.class?._id,
                targetRole: 'student',
                sendToPublic: false,
                metadata: {
                    examId: exam._id.toString(),
                    examName: exam.name,
                    subjectName,
                    className,
                    reminderType: 'exam-day',
                },
            });

            logger.info(`[Exam Cron] Sent exam reminder for: "${exam.name}" (${className})`);
            sentCount++;
        }

        const durationMs = Date.now() - startTime;
        await recordCronLog({
            jobName: 'exam',
            trigger,
            status: 'success',
            message: `Processed ${todayExams.length} exam(s): sent ${sentCount}, skipped ${skippedCount}`,
            details: { totalExams: todayExams.length, sentCount, skippedCount },
            durationMs,
        });

        return { sent: sentCount > 0, sentCount, skippedCount, totalExams: todayExams.length };
    } catch (error) {
        logger.error('[Exam Cron] Error running exam reminders', error);
        await recordCronLog({
            jobName: 'exam',
            trigger,
            status: 'failed',
            message: error.message,
            details: { stack: error.stack },
            durationMs: Date.now() - startTime,
        });
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────
// 5. Stale FCM Token Cleanup (Weekly — Sunday 03:00 AM IST)
// ─────────────────────────────────────────────────────────────

async function runStaleTokenCleanup(options = {}) {
    const { trigger = 'scheduled' } = options;
    const startTime = Date.now();
    try {
        const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

        const result = await FCMToken.deleteMany({
            updatedAt: { $lt: sixtyDaysAgo },
        });

        const durationMs = Date.now() - startTime;
        logger.info(`[Token Cleanup] Removed ${result.deletedCount} stale FCM tokens (not updated in 60+ days)`);
        await recordCronLog({
            jobName: 'stale_token',
            trigger,
            status: 'success',
            message: `Removed ${result.deletedCount} stale FCM tokens (older than 60 days)`,
            details: { deletedCount: result.deletedCount },
            durationMs,
        });
        return { deletedCount: result.deletedCount };
    } catch (error) {
        logger.error('[Token Cleanup] Error', error);
        await recordCronLog({
            jobName: 'stale_token',
            trigger,
            status: 'failed',
            message: error.message,
            details: { stack: error.stack },
            durationMs: Date.now() - startTime,
        });
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────
// 6. Old Notification Cleanup (Weekly — Sunday 04:00 AM IST)
// ─────────────────────────────────────────────────────────────

async function runNotificationCleanup(options = {}) {
    const { trigger = 'scheduled' } = options;
    const startTime = Date.now();
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        // Auto-archive notifications older than 30 days
        const archiveResult = await Notification.updateMany(
            { isArchived: false, createdAt: { $lt: thirtyDaysAgo } },
            { $set: { isArchived: true, archivedAt: new Date() } },
        );

        // Delete archived notifications older than 90 days
        const deleteResult = await Notification.deleteMany({
            isArchived: true,
            createdAt: { $lt: ninetyDaysAgo },
        });

        const durationMs = Date.now() - startTime;
        logger.info(
            `[Notification Cleanup] Archived ${archiveResult.modifiedCount} old notifications, deleted ${deleteResult.deletedCount} expired notifications`,
        );

        await recordCronLog({
            jobName: 'notification_cleanup',
            trigger,
            status: 'success',
            message: `Archived ${archiveResult.modifiedCount} notifications (>30d), deleted ${deleteResult.deletedCount} (>90d)`,
            details: { archivedCount: archiveResult.modifiedCount, deletedCount: deleteResult.deletedCount },
            durationMs,
        });

        return {
            archivedCount: archiveResult.modifiedCount,
            deletedCount: deleteResult.deletedCount,
        };
    } catch (error) {
        logger.error('[Notification Cleanup] Error', error);
        await recordCronLog({
            jobName: 'notification_cleanup',
            trigger,
            status: 'failed',
            message: error.message,
            details: { stack: error.stack },
            durationMs: Date.now() - startTime,
        });
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────
// 7. Monthly Fee Reminders (1st of every month at 09:00 AM IST)
// ─────────────────────────────────────────────────────────────

async function runMonthlyFeeReminders(options = {}) {
    const { trigger = 'scheduled', force = false } = options;
    const startTime = Date.now();
    try {
        const { startOfDay, endOfDay } = getISTDayBounds();

        logger.info(`[Monthly Fee Cron] Running monthly fee reminder check [trigger: ${trigger}, force: ${force}]`);

        // Duplicate guard — check if monthly fee reminder already sent today
        const alreadySent = await Notification.findOne({
            category: 'fee',
            'metadata.reminderType': 'monthly-fee-reminder',
            createdAt: { $gte: startOfDay, $lte: endOfDay },
        });

        if (alreadySent && !force) {
            const durationMs = Date.now() - startTime;
            logger.info('[Monthly Fee Cron] Monthly fee reminders already sent today — skipping');
            await recordCronLog({
                jobName: 'monthly_fee',
                trigger,
                status: 'skipped',
                message: 'Monthly fee reminders already sent today',
                details: { existingNotificationId: alreadySent._id },
                durationMs,
            });
            return { skipped: true, reason: 'Monthly fee reminders already sent today' };
        }

        // Find active academic year
        const activeYear = await AcademicYear.findOne({ isActive: true });
        if (!activeYear) {
            const durationMs = Date.now() - startTime;
            logger.warn('[Monthly Fee Cron] No active academic year found — skipping');
            await recordCronLog({
                jobName: 'monthly_fee',
                trigger,
                status: 'skipped',
                message: 'No active academic year found',
                durationMs,
            });
            return { sent: false, reason: 'No active academic year found' };
        }

        // Fetch all active students
        const students = await User.find({
            role: 'student',
            isActive: { $ne: false },
        }).select('_id name currentClass academicYear');

        if (students.length === 0) {
            const durationMs = Date.now() - startTime;
            logger.info('[Monthly Fee Cron] No active students found');
            await recordCronLog({
                jobName: 'monthly_fee',
                trigger,
                status: 'success',
                message: 'No active students found to remind',
                details: { totalStudents: 0 },
                durationMs,
            });
            return { sent: false, reason: 'No active students found' };
        }

        const studentIds = students.map(s => s._id);

        // Batch fetch fee structures for the active year
        const feeStructures = await FeeStructure.find({
            academicYear: activeYear._id,
            type: 'class_default',
        }).lean();
        const feeStructureByClass = new Map(feeStructures.map(fs => [fs.class.toString(), fs]));

        // Batch fetch imported StudentFee records
        const studentFees = await StudentFee.find({
            student: { $in: studentIds },
            academicYear: activeYear._id,
        }).lean();
        const studentFeeMap = new Map(studentFees.map(sf => [sf.student.toString(), sf]));

        // Batch fetch FeePayment records for students without StudentFee
        const payments = await FeePayment.find({
            student: { $in: studentIds },
            academicYear: activeYear._id,
            status: 'success',
        }).lean();

        const paidByStudent = new Map();
        for (const p of payments) {
            const sid = p.student.toString();
            paidByStudent.set(sid, (paidByStudent.get(sid) || 0) + (p.amount || 0));
        }

        let sentCount = 0;

        for (const student of students) {
            const sid = student._id.toString();
            let pendingAmount = 0;

            if (studentFeeMap.has(sid)) {
                // Use imported StudentFee as source of truth
                const sf = studentFeeMap.get(sid);
                pendingAmount = sf.pendingAmount || 0;
            } else if (student.currentClass && feeStructureByClass.has(student.currentClass.toString())) {
                // Fallback to FeeStructure minus successful FeePayments
                const fs = feeStructureByClass.get(student.currentClass.toString());
                const totalPaid = paidByStudent.get(sid) || 0;
                pendingAmount = (fs.totalAmount || 0) - totalPaid;
            }

            // Only send reminder if there is a pending balance (minimum ₹100)
            if (pendingAmount >= 100) {
                const studentName = toTitleCase(student.name);
                const title = '💰 Fee Payment Reminder';
                const message = `Dear ${studentName}, you have an outstanding fee balance of ₹${pendingAmount.toLocaleString('en-IN')}. Please ensure timely payment at your earliest convenience.`;

                await sendTargetedNotification(
                    'user',
                    student._id,
                    {
                        title,
                        message,
                        type: 'Fee',
                        category: 'fee',
                        priority: pendingAmount > 5000 ? 'high' : 'medium',
                    },
                    false,
                );

                await Notification.create({
                    title,
                    message,
                    type: 'Fee',
                    category: 'fee',
                    priority: pendingAmount > 5000 ? 'high' : 'medium',
                    recipient: student._id,
                    targetRole: 'student',
                    sendToPublic: false,
                    actionType: 'navigate',
                    actionData: '/student/fees',
                    metadata: {
                        studentId: sid,
                        studentName,
                        pendingAmount,
                        reminderType: 'monthly-fee-reminder',
                    },
                });

                sentCount++;
            }
        }

        const durationMs = Date.now() - startTime;
        logger.info(`[Monthly Fee Cron] Sent monthly fee reminders to ${sentCount} student(s) (checked ${students.length} total students)`);
        await recordCronLog({
            jobName: 'monthly_fee',
            trigger,
            status: 'success',
            message: `Sent fee reminders to ${sentCount} student(s) of ${students.length} evaluated`,
            details: { sentCount, totalChecked: students.length },
            durationMs,
        });

        return {
            sent: sentCount > 0,
            sentCount,
            totalStudentsChecked: students.length,
        };
    } catch (error) {
        logger.error('[Monthly Fee Cron] Error running monthly fee reminders', error);
        await recordCronLog({
            jobName: 'monthly_fee',
            trigger,
            status: 'failed',
            message: error.message,
            details: { stack: error.stack },
            durationMs: Date.now() - startTime,
        });
        throw error;
    }
}

// ─────────────────────────────────────────────────────────────
// Cron Registration
// ─────────────────────────────────────────────────────────────

function startAllCronJobs() {
    const TIMEZONE = 'Asia/Kolkata';

    // 07:00 AM IST — Exam-day reminders (before school starts)
    cron.schedule('0 7 * * *', async () => {
        logger.info('[Cron] 07:00 AM IST — Running exam-day reminders');
        try { await runExamDayReminders({ trigger: 'scheduled' }); }
        catch (err) { logger.error('[Exam Cron] Unhandled error in scheduled job', err); }
    }, { timezone: TIMEZONE });

    // 08:00 AM IST — Birthday & Event-day notifications
    cron.schedule('0 8 * * *', async () => {
        logger.info('[Cron] 08:00 AM IST — Running birthday & event notifications');
        try { await runBirthdayNotifications({ trigger: 'scheduled' }); }
        catch (err) { logger.error('[Birthday Cron] Unhandled error in scheduled job', err); }
        try { await runEventNotifications({ trigger: 'scheduled' }); }
        catch (err) { logger.error('[Event Cron] Unhandled error in scheduled job', err); }
    }, { timezone: TIMEZONE });

    // 09:00 AM IST on 1st of every month — Monthly fee reminders
    cron.schedule('0 9 1 * *', async () => {
        logger.info('[Cron] 1st of month 09:00 AM IST — Running monthly fee reminders');
        try { await runMonthlyFeeReminders({ trigger: 'scheduled' }); }
        catch (err) { logger.error('[Monthly Fee Cron] Unhandled error in scheduled job', err); }
    }, { timezone: TIMEZONE });

    // 08:00 PM IST — Event eve reminders (for tomorrow's events)
    cron.schedule('0 20 * * *', async () => {
        logger.info('[Cron] 08:00 PM IST — Running event eve reminders');
        try { await runEventEveReminders({ trigger: 'scheduled' }); }
        catch (err) { logger.error('[Event Eve Cron] Unhandled error in scheduled job', err); }
    }, { timezone: TIMEZONE });

    // Every Sunday at 03:00 AM IST — Stale FCM token cleanup
    cron.schedule('0 3 * * 0', async () => {
        logger.info('[Cron] Sunday 03:00 AM IST — Running stale token cleanup');
        try { await runStaleTokenCleanup({ trigger: 'scheduled' }); }
        catch (err) { logger.error('[Token Cleanup] Unhandled error in scheduled job', err); }
    }, { timezone: TIMEZONE });

    // Every Sunday at 04:00 AM IST — Old notification cleanup
    cron.schedule('0 4 * * 0', async () => {
        logger.info('[Cron] Sunday 04:00 AM IST — Running notification cleanup');
        try { await runNotificationCleanup({ trigger: 'scheduled' }); }
        catch (err) { logger.error('[Notification Cleanup] Unhandled error in scheduled job', err); }
    }, { timezone: TIMEZONE });

    // Every 6 hours at minute 30 — Fee sync from Google Sheets (safety net)
    if (process.env.FEE_SYNC_ENABLED === 'true') {
        cron.schedule('30 */6 * * *', async () => {
            logger.info('[Cron] Running scheduled fee sync from Google Sheets');
            try { await runFeeSync({ trigger: 'scheduled' }); }
            catch (err) { logger.error('[Fee Sync Cron] Unhandled error in scheduled job', err); }
        }, { timezone: TIMEZONE });
        logger.info('   ✅ Fee sync from Google Sheets enabled (every 6 hours)');
    }

    logger.info('✅ All cron jobs registered:');
    logger.info('   • 07:00 AM IST — Exam-day reminders');
    logger.info('   • 08:00 AM IST — Birthday & event-day notifications');
    logger.info('   • 09:00 AM IST (1st of month) — Monthly fee reminders');
    logger.info('   • 08:00 PM IST — Event eve reminders');
    logger.info('   • Sunday 03:00 AM — Stale FCM token cleanup');
    logger.info('   • Sunday 04:00 AM — Old notification cleanup');
    if (process.env.FEE_SYNC_ENABLED === 'true') {
        logger.info('   • Every 6 hours (xx:30) — Fee sync from Google Sheets');
    }

    // ── Startup catchup ──
    // If the server starts after cron fire times, run applicable jobs now.
    // Duplicate guards inside each function prevent double-sends.
    const currentHour = getISTHour();
    const currentDate = getISTDate();

    if (currentHour >= 7) {
        logger.info('[Cron] Server started after 07:00 AM IST — running exam catchup');
        runExamDayReminders({ trigger: 'catchup' }).catch(err => logger.error('[Exam Cron] Catchup error', err));
    }
    if (currentHour >= 8) {
        logger.info('[Cron] Server started after 08:00 AM IST — running birthday & event catchup');
        Promise.resolve()
            .then(() => runBirthdayNotifications({ trigger: 'catchup' }))
            .catch(err => logger.error('[Birthday Cron] Catchup error', err))
            .then(() => runEventNotifications({ trigger: 'catchup' }))
            .catch(err => logger.error('[Event Cron] Catchup error', err));
    }
    if (currentDate === 1 && currentHour >= 9) {
        logger.info('[Cron] Server started on 1st of month after 09:00 AM IST — running fee reminder catchup');
        runMonthlyFeeReminders({ trigger: 'catchup' }).catch(err => logger.error('[Monthly Fee Cron] Catchup error', err));
    }
    if (currentHour >= 20) {
        logger.info('[Cron] Server started after 08:00 PM IST — running event eve catchup');
        runEventEveReminders({ trigger: 'catchup' }).catch(err => logger.error('[Event Eve Cron] Catchup error', err));
    }
}

/**
 * Run all due daily jobs based on current IST time.
 * Used for unified webhook triggers, manual admin triggers, and catchup.
 */
async function runAllDailyJobs(options = {}) {
    const { trigger = 'scheduled', force = false } = options;
    const startTime = Date.now();
    const currentHour = getISTHour();
    const currentDate = getISTDate();
    const results = {};

    logger.info(`[Cron Dispatcher] Running daily jobs check (trigger: ${trigger}, force: ${force}, IST hour: ${currentHour}:00, Date: ${currentDate})`);

    // For manual triggers or forced runs, execute all core daily checks unconditionally
    const runNow = trigger === 'manual' || force;

    // 1. Exam reminders (due if >= 7 AM IST, or manual/force)
    if (runNow || currentHour >= 7) {
        try {
            results.examReminders = await runExamDayReminders({ trigger, force });
        } catch (err) {
            results.examReminders = { error: err.message };
            logger.error('[Cron Dispatcher] Exam reminders failed', err);
        }
    }

    // 2. Birthday notifications (due if >= 8 AM IST, or manual/force)
    if (runNow || currentHour >= 8) {
        try {
            results.birthdays = await runBirthdayNotifications({ trigger, force });
        } catch (err) {
            results.birthdays = { error: err.message };
            logger.error('[Cron Dispatcher] Birthday notifications failed', err);
        }

        // 3. Event-day notifications (due if >= 8 AM IST, or manual/force)
        try {
            results.events = await runEventNotifications({ trigger, force });
        } catch (err) {
            results.events = { error: err.message };
            logger.error('[Cron Dispatcher] Event notifications failed', err);
        }
    }

    // 4. Monthly fee reminders (1st of month, >= 9 AM IST, or if explicitly requested)
    if (currentDate === 1 && (runNow || currentHour >= 9)) {
        try {
            results.monthlyFees = await runMonthlyFeeReminders({ trigger, force });
        } catch (err) {
            results.monthlyFees = { error: err.message };
            logger.error('[Cron Dispatcher] Monthly fee reminders failed', err);
        }
    }

    // 5. Event eve reminders (due if >= 8 PM IST)
    if (currentHour >= 20) {
        try {
            results.eventEve = await runEventEveReminders({ trigger, force });
        } catch (err) {
            results.eventEve = { error: err.message };
            logger.error('[Cron Dispatcher] Event eve reminders failed', err);
        }
    }

    const durationMs = Date.now() - startTime;
    await recordCronLog({
        jobName: 'all_daily',
        trigger,
        status: Object.values(results).some(r => r && r.error) ? 'failed' : 'success',
        message: `All daily jobs completed in ${durationMs}ms`,
        details: results,
        durationMs,
    });

    return results;
}

module.exports = {
    startAllCronJobs,
    runAllDailyJobs,
    runBirthdayNotifications,
    runEventNotifications,
    runEventEveReminders,
    runExamDayReminders,
    runMonthlyFeeReminders,
    runStaleTokenCleanup,
    runNotificationCleanup,
    getCronLogs,
    recordCronLog,
};
