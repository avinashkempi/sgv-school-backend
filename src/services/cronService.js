const cron = require('node-cron');
const User = require('../models/User');
const Event = require('../models/Event');
const Notification = require('../models/Notification');
const { sendTargetedNotification } = require('./notificationService');

/**
 * Core birthday notification logic.
 * - Finds users whose birthday (month + day) matches today.
 * - Guards against duplicate sends.
 * - Broadcasts a single notification to ALL logged-in users.
 */
async function runBirthdayNotifications() {
    try {
        const now = new Date();
        const todayMonth = now.getMonth() + 1; // 1-12
        const todayDay = now.getDate();

        console.log(`[Birthday Cron] Running check for ${todayDay}/${todayMonth}`);

        // --- Duplicate-run guard ---
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);

        const alreadySent = await Notification.findOne({
            category: 'birthday',
            createdAt: { $gte: startOfDay, $lte: endOfDay },
        });

        if (alreadySent) {
            console.log('[Birthday Cron] Birthday notification already sent today. Skipping.');
            return { skipped: true, reason: 'Already sent today' };
        }
        // --- End duplicate guard ---

        // Find users who have a birthday today (match month and day regardless of year)
        const birthdayUsers = await User.find({
            dateOfBirth: { $exists: true, $ne: null },
            $expr: {
                $and: [
                    { $eq: [{ $month: '$dateOfBirth' }, todayMonth] },
                    { $eq: [{ $dayOfMonth: '$dateOfBirth' }, todayDay] },
                ],
            },
        }).select('name role');

        if (birthdayUsers.length === 0) {
            console.log('[Birthday Cron] No birthdays today.');
            return { sent: false, reason: 'No birthdays today' };
        }

        const names = birthdayUsers.map(u => u.name).join(', ');
        const title = '🎂 Happy Birthday!';
        const message =
            birthdayUsers.length === 1
                ? `Today is ${names}'s birthday! 🎉 Wish them a great day!`
                : `Today is the birthday of ${names}! 🎉 Wish them a great day!`;

        const result = await sendTargetedNotification(
            'all',
            null,
            { title, message, type: 'Birthday' },
            false, // only authenticated (logged-in) users
        );

        await Notification.create({
            title,
            message,
            type: 'Birthday',
            category: 'birthday',
            priority: 'medium',
            recipient: null,
            targetRole: 'all',
            sendToPublic: false,
            metadata: {
                birthdayUserIds: birthdayUsers.map(u => u._id.toString()),
                birthdayUserNames: birthdayUsers.map(u => u.name),
            },
        });

        console.log(`[Birthday Cron] Sent birthday notification for ${birthdayUsers.length} user(s): ${names}`);
        return { sent: true, userCount: birthdayUsers.length, fcmResult: result };
    } catch (error) {
        console.error('[Birthday Cron] Error running birthday notifications:', error);
        throw error;
    }
}

/**
 * Core event-day notification logic.
 * - Finds all Events whose `date` falls on today.
 * - Guards against duplicate sends per event.
 * - Broadcasts one notification per event to ALL logged-in users.
 */
async function runEventNotifications() {
    try {
        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);

        console.log(`[Event Cron] Checking for events on ${startOfDay.toDateString()}`);

        // Find all events scheduled for today
        const todayEvents = await Event.find({
            date: { $gte: startOfDay, $lte: endOfDay },
        }).select('title description _id');

        if (todayEvents.length === 0) {
            console.log('[Event Cron] No events today.');
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
            });

            if (alreadySent) {
                console.log(`[Event Cron] Notification already sent for event "${event.title}". Skipping.`);
                skippedCount++;
                continue;
            }

            const title = `📅 Today's Event: ${event.title}`;
            const message = event.description
                ? event.description.substring(0, 150)
                : `Don't forget — "${event.title}" is happening today!`;

            await sendTargetedNotification(
                'all',
                null,
                { title, message, type: 'Event' },
                false, // only authenticated (logged-in) users
            );

            // Persist with eventId so duplicate guard works across restarts
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
                metadata: { eventTitle: event.title },
            });

            console.log(`[Event Cron] Sent notification for event: "${event.title}"`);
            sentCount++;
        }

        return {
            sent: sentCount > 0,
            sentCount,
            skippedCount,
            totalEvents: todayEvents.length,
        };
    } catch (error) {
        console.error('[Event Cron] Error running event notifications:', error);
        throw error;
    }
}

/**
 * Register all daily cron jobs.
 * Runs every day at 08:00 AM server time.
 * Also runs immediately on startup if it's past 08:00 AM and today's jobs haven't run yet.
 */
function startBirthdayCron() {
    // "0 8 * * *" = at 08:00 every day
    cron.schedule('0 8 * * *', async () => {
        console.log('[Cron] Daily 08:00 AM job triggered');
        try {
            await runBirthdayNotifications();
        } catch (err) {
            console.error('[Birthday Cron] Unhandled error in scheduled job:', err);
        }
        try {
            await runEventNotifications();
        } catch (err) {
            console.error('[Event Cron] Unhandled error in scheduled job:', err);
        }
    });

    console.log('✅ Birthday & Event cron jobs registered (run daily at 08:00 AM)');

    // Startup catchup: if the server starts after 08:00 AM, run immediately.
    // The duplicate guards inside each function will safely skip if already sent today.
    const now = new Date();
    const eightAM = new Date(now);
    eightAM.setHours(8, 0, 0, 0);

    if (now >= eightAM) {
        console.log('[Cron] Server started after 08:00 AM — running catchup check now...');
        Promise.resolve()
            .then(() => runBirthdayNotifications())
            .catch(err => console.error('[Birthday Cron] Catchup error:', err))
            .then(() => runEventNotifications())
            .catch(err => console.error('[Event Cron] Catchup error:', err));
    }
}

module.exports = { startBirthdayCron, runBirthdayNotifications, runEventNotifications };
