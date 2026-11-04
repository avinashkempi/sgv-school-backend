const Event = require('../models/Event');

const TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Converts any Date object, ISO string, or timestamp into YYYY-MM-DD string in Asia/Kolkata (IST).
 * @param {Date|string|number} dateInput 
 * @returns {string} e.g. "2026-08-19"
 */
function getISTDateString(dateInput = new Date()) {
    if (!dateInput) return '';
    if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
        return dateInput.trim();
    }
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) {
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
 * Extracts year and 1-based month in Asia/Kolkata.
 * @param {Date|string|number} dateInput 
 * @returns {{ year: number, month: number }} e.g. { year: 2026, month: 11 }
 */
function getISTMonthYear(dateInput = new Date()) {
    const dateStr = getISTDateString(dateInput);
    if (dateStr) {
        const [y, m] = dateStr.split('-').map(Number);
        if (y && m) return { year: y, month: m };
    }
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    const valid = !isNaN(d.getTime()) ? d : new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: 'numeric'
    }).formatToParts(valid);
    const year = Number(parts.find(p => p.type === 'year')?.value) || 2026;
    const month = Number(parts.find(p => p.type === 'month')?.value) || 1;
    return { year, month };
}

/**
 * Extracts year and 1-based month for the previous month in Asia/Kolkata (IST).
 * @param {Date|string|number} dateInput 
 * @returns {{ year: number, month: number }}
 */
function getPreviousMonthYear(dateInput = new Date()) {
    const { year, month } = getISTMonthYear(dateInput);
    if (month === 1) return { year: year - 1, month: 12 };
    return { year, month: month - 1 };
}

/**
 * Returns detailed date components in Asia/Kolkata.
 * @param {Date|string|number} dateInput 
 * @returns {{ year: number, month: number, day: number, weekday: string }}
 */
function getISTDateComponents(dateInput = new Date()) {
    const dateStr = getISTDateString(dateInput);
    const [year, month, day] = (dateStr || getISTToday()).split('-').map(Number);
    const weekday = isISTSunday(dateStr) ? 'Sun' : new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        weekday: 'short'
    }).format(new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00+05:30`));

    return { year, month, day, weekday };
}

/**
 * Checks if a date falls on a Sunday in Asia/Kolkata (IST).
 * @param {Date|string|number} dateInput 
 * @returns {boolean}
 */
function isISTSunday(dateInput) {
    if (!dateInput) return false;
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
    const dateStr = getISTDateString(dateInput) || getISTToday();
    return new Date(`${dateStr}T00:00:00.000Z`);
}

/**
 * Returns precise UTC boundaries covering the entire 24-hour day in Asia/Kolkata (00:00:00.000 to 23:59:59.999 IST).
 * Compatible with both exact-timestamp models and normalized UTC midnight models.
 * @param {Date|string|number} dateInput 
 * @returns {{ startOfDay: Date, endOfDay: Date, dateStr: string }}
 */
function getISTDayBounds(dateInput) {
    const dateStr = getISTDateString(dateInput) || getISTToday();
    // 00:00:00 IST = 18:30:00 UTC previous day
    const startOfDay = new Date(`${dateStr}T00:00:00+05:30`);
    // 23:59:59.999 IST = 18:29:59.999 UTC current day
    const endOfDay = new Date(`${dateStr}T23:59:59.999+05:30`);

    return { startOfDay, endOfDay, dateStr };
}

/**
 * Returns { startOfDay, endOfDay, dateStr } for tomorrow in Asia/Kolkata.
 * @param {Date|string|number} dateInput 
 * @returns {{ startOfDay: Date, endOfDay: Date, dateStr: string }}
 */
function getISTTomorrowBounds(dateInput = new Date()) {
    const { startOfDay } = getISTDayBounds(dateInput);
    // Advance by 24 hours
    const tomorrowStart = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowEnd = new Date(tomorrowStart.getTime() + 24 * 60 * 60 * 1000 - 1);
    const dateStr = getISTDateString(tomorrowStart);
    return { startOfDay: tomorrowStart, endOfDay: tomorrowEnd, dateStr };
}

/**
 * Returns start and end UTC boundaries for a specific month in Asia/Kolkata.
 * @param {number} year - Full year e.g. 2026
 * @param {number} month - 1-based month (1-12)
 * @returns {{ startOfMonth: Date, endOfMonth: Date, year: number, month: number }}
 */
function getISTMonthBounds(year, month) {
    const y = Number(year) || getISTMonthYear().year;
    const m = Number(month) || getISTMonthYear().month;
    const mStr = String(m).padStart(2, '0');
    // First day of month at 00:00:00 IST
    const startOfMonth = new Date(`${y}-${mStr}-01T00:00:00+05:30`);
    // Find last day of month in IST
    const nextMonthYear = m === 12 ? y + 1 : y;
    const nextMonth = m === 12 ? 1 : m + 1;
    const nextMonthStr = String(nextMonth).padStart(2, '0');
    const startOfNextMonth = new Date(`${nextMonthYear}-${nextMonthStr}-01T00:00:00+05:30`);
    const endOfMonth = new Date(startOfNextMonth.getTime() - 1);

    return { startOfMonth, endOfMonth, year: y, month: m };
}

/**
 * Formats a Date object into readable Indian format e.g. "15 Aug 2026".
 * @param {Date|string|number} dateInput 
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
function formatISTDate(dateInput, options = {}) {
    if (!dateInput) return '';
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);
    const defaultOptions = {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: TIMEZONE,
        ...options
    };
    return new Intl.DateTimeFormat('en-IN', defaultOptions).format(d);
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

    const normalizedDate = getISTDateObject(dateStr);

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
    IST_OFFSET_MS,
    getISTDateString,
    getISTToday,
    getISTMonthYear,
    getPreviousMonthYear,
    getISTDateComponents,
    isISTSunday,
    getISTDateObject,
    getISTDayBounds,
    getISTTomorrowBounds,
    getISTMonthBounds,
    formatISTDate,
    validateAttendanceDate
};
