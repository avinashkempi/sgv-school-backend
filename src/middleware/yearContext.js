const AcademicYear = require('../models/AcademicYear');

/**
 * Middleware to intercept 'x-academic-year' headers and provide contextual
 * data fetching across the app for Super Admin "Time Travel" features.
 */
const yearContext = async (req, res, next) => {
    try {
        // Fetch active year to attach to all responses for synchronization
        const activeYear = await AcademicYear.findOne({ isActive: true });
        if (activeYear) {
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
        const targetYear = await AcademicYear.findById(requestedYearId);
        if (!targetYear) {
            return res.status(404).json({ success: false, message: 'Requested Academic Year not found.' });
        }

        // Bind logic based on status
        req.academicYearContext = targetYear._id.toString();

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
    requireOpenYear
};
