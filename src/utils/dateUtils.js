const Event = require('../models/Event');

const TIMEZONE = 'Asia/Kolkata';

/**
 * Converts any Date object, ISO string, or timestamp into YYYY-MM-DD string in Asia/Kolkata (IST).
 * @param {Date|string|number} dateInput 
 * @returns {string} e.g. "2026-08-19"
 */
function getISTDateString(dateInput = new Date()) {
    if (!dateInput) return '';
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) {
        // If it's already a valid YYYY-MM-DD string
        if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
            return dateInput.trim();
        }
        return '';
    }

    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);
}

/**
 * Returns today's date string (YYYY-MM-DD) in Asia/Kolkata.
 * @returns {string} e.g. "2026-08-19"
 */
function getISTToday() {
    return getISTDateString(new Date());
}

/**
 * Checks if a date falls on a Sunday in Asia/Kolkata (IST).
 * @param {Date|string|number} dateInput 
 * @returns {boolean}
 */
function isISTSunday(dateInput) {
    if (!dateInput) return false;
    // If it's a YYYY-MM-DD string, parse it cleanly in IST
    let d;
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
        d = new Date(`${dateInput.trim()}T12:00:00+05:30`);
    } else {
        d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    }
    if (isNaN(d.getTime())) return false;

    const weekday = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        weekday: 'short'
    }).format(d);

    return weekday === 'Sun';
}

/**
 * Returns normalized UTC midnight Date object for storing calendar-day dates cleanly.
 * e.g. for "2026-08-19" -> 2026-08-19T00:00:00.000Z
 * @param {Date|string|number} dateInput 
 * @returns {Date}
 */
function getISTDateObject(dateInput) {
    const dateStr = getISTDateString(dateInput);
    if (!dateStr) return new Date();
    return new Date(`${dateStr}T00:00:00.000Z`);
}

/**
 * Returns broad query boundaries to cover the entire calendar day for MongoDB queries.
 * @param {Date|string|number} dateInput 
 * @returns {{ startOfDay: Date, endOfDay: Date, dateStr: string }}
 */
function getISTDayBounds(dateInput) {
    const dateStr = getISTDateString(dateInput);
    if (!dateStr) {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const end = new Date(now);
        end.setHours(23, 59, 59, 999);
        return { startOfDay: now, endOfDay: end, dateStr: getISTToday() };
    }

    const startOfDay = new Date(`${dateStr}T00:00:00.000Z`);
    const endOfDay = new Date(`${dateStr}T23:59:59.999Z`);

    return { startOfDay, endOfDay, dateStr };
}

/**
 * Server-side guard to validate if attendance can be marked on a given date.
 * Checks for:
 * 1. Sunday (in IST)
 * 2. Declared school holiday (Event with isHoliday: true in IST)
 * 
 * @param {Date|string|number} dateInput 
 * @returns {Promise<{ allowed: boolean, reason?: string, dateStr: string, normalizedDate: Date }>}
 */
async function validateAttendanceDate(dateInput) {
    const dateStr = getISTDateString(dateInput);
    if (!dateStr) {
        return { allowed: false, reason: 'Invalid date provided', dateStr: '', normalizedDate: new Date() };
    }

    const normalizedDate = new Date(`${dateStr}T00:00:00.000Z`);

    // 1. Check if Sunday in IST
    if (isISTSunday(dateInput)) {
        return {
            allowed: false,
            reason: 'Attendance cannot be marked on Sundays (Weekend)',
            dateStr,
            normalizedDate
        };
    }

    // 2. Check if declared school holiday
    const { startOfDay, endOfDay } = getISTDayBounds(dateInput);
    const holiday = await Event.findOne({
        isHoliday: true,
        date: { $gte: startOfDay, $lte: endOfDay }
    }).select('title').lean();

    if (holiday) {
        return {
            allowed: false,
            reason: `Attendance cannot be marked on holidays (${holiday.title || 'School Holiday'})`,
            dateStr,
            normalizedDate
        };
    }

    return {
        allowed: true,
        dateStr,
        normalizedDate
    };
}

module.exports = {
    TIMEZONE,
    getISTDateString,
    getISTToday,
    isISTSunday,
    getISTDateObject,
    getISTDayBounds,
    validateAttendanceDate
};
