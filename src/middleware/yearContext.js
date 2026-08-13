const AcademicYear = require('../models/AcademicYear');
const { cacheGet, cacheSet, cacheDel } = require('../config/redis');

// In-memory cache for active academic year (5-minute TTL)
let cachedActiveYear = null;
let activeYearCachedAt = 0;
const ACTIVE_YEAR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REDIS_KEY_ACTIVE_YEAR = 'activeAcademicYear';
const REDIS_TTL_SECONDS = 300; // 5 minutes

/**
 * Get active academic year with caching (In-Memory -> Redis -> MongoDB)
 */
const getActiveYear = async (forceRefresh = false) => {
    const now = Date.now();

    // 1. Fast path: check local in-memory cache
    if (!forceRefresh && cachedActiveYear && (now - activeYearCachedAt < ACTIVE_YEAR_CACHE_TTL_MS)) {
        return cachedActiveYear;
    }

    // 2. Check Redis cache
    if (!forceRefresh) {
        try {
            const redisYear = await cacheGet(REDIS_KEY_ACTIVE_YEAR);
            if (redisYear) {
                cachedActiveYear = redisYear;
                activeYearCachedAt = now;
                return redisYear;
            }
        } catch (_) {
            // graceful fallback
        }
    }

    // 3. Fallback to MongoDB
    const year = await AcademicYear.findOne({ isActive: true }).lean();
    if (year) {
        cachedActiveYear = year;
        activeYearCachedAt = now;
        // Populate Redis cache asynchronously
        cacheSet(REDIS_KEY_ACTIVE_YEAR, year, REDIS_TTL_SECONDS).catch(() => {});
    }
    return year;
};

/**
 * Explicitly invalidate the active academic year cache across in-memory and Redis
 */
const invalidateYearCache = async () => {
    cachedActiveYear = null;
    activeYearCachedAt = 0;
    try {
        await cacheDel(REDIS_KEY_ACTIVE_YEAR);
    } catch (_) {
        // graceful fallback
    }
};

/**
 * Middleware to intercept 'x-academic-year' headers and provide contextual
 * data fetching across the app for Super Admin "Time Travel" features.
 */
const yearContext = async (req, res, next) => {
    try {
        // Fetch active year with in-memory caching to eliminate per-request DB queries
        const activeYear = await getActiveYear();
        if (activeYear) {
            req.activeYear = activeYear;
            res.setHeader('X-Active-Academic-Year', JSON.stringify({
                _id: activeYear._id.toString(),
                name: activeYear.name,
                isActive: true,
                status: activeYear.status
            }));
        }

        const requestedYearId = req.headers['x-academic-year'];
        const isSuperAdmin = req.user && req.user.role === 'super admin';

        if (!requestedYearId || !isSuperAdmin) {
            // Default to the current active year if no travel requested or user is not Super Admin
            if (!activeYear) {
                return res.status(500).json({ success: false, message: 'No active academic year found in system.' });
            }
            req.academicYearContext = activeYear._id.toString();
            req.isReadOnly = false;
            return next();
        }

        // Validate Requested Year
        const targetYear = await AcademicYear.findById(requestedYearId).lean();
        if (!targetYear) {
            return res.status(404).json({ success: false, message: 'Requested Academic Year not found.' });
        }

        // Bind logic based on status
        req.academicYearContext = targetYear._id.toString();
        req.activeYear = targetYear;

        // If it's archived, enforce strict read-only policy for safety
        if (targetYear.status === 'archived') {
            req.isReadOnly = true;
        } else {
            req.isReadOnly = false;
        }

        next();
    } catch (err) {
        console.error('Error in yearContext middleware:', err);
        return res.status(500).json({ success: false, message: 'Failed to resolve Academic Year context.' });
    }
};

/**
 * Middleware strict guard to reject POST/PUT/DELETE requests 
 * if the user is traversing a Read-Only (archived) year.
 */
const requireOpenYear = (req, res, next) => {
    // Exclude GET requests from blocking
    if (req.method === 'GET') {
        return next();
    }

    if (req.isReadOnly) {
        return res.status(403).json({
            success: false,
            message: 'Forbidden: You cannot modify data in an archived Academic Year.'
        });
    }

    next();
};

module.exports = {
    yearContext,
    requireOpenYear,
    getActiveYear,
    invalidateYearCache
};

