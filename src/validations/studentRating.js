const { body, check } = require('express-validator');

const VALID_RATING_RANGE = { min: 1, max: 5 };

const ratingFieldValidation = (fieldName, label) => [
    body(`ratings.*.${fieldName}`)
        .if((value, { req, path }) => {
            const match = path.match(/ratings(?:\[(\d+)\]|\.(\d+)\.)/);
            const indexStr = match ? (match[1] || match[2]) : null;
            if (indexStr !== null && req.body && Array.isArray(req.body.ratings)) {
                const index = parseInt(indexStr, 10);
                const item = req.body.ratings[index];
                if (item?.isExempt === true || item?.isExempt === 'true') return false;
            }
            return true;
        })
        .notEmpty()
        .withMessage(`${label} is required`)
        .isInt(VALID_RATING_RANGE)
        .withMessage(`${label} must be a whole number between 1 and 5`)
];

/**
 * Validation rules for bulk student ratings submission.
 * Expects body: { subjectId, month, year, ratings: [{ studentId, classEngagement, homeworkClasswork, behaviourSocial, englishComm, remarks, isExempt, exemptionReason }] }
 */
const bulkRatingValidation = [
    body('subjectId')
        .notEmpty()
        .withMessage('Subject ID is required')
        .isMongoId()
        .withMessage('Invalid subject ID'),
    body('month')
        .notEmpty()
        .withMessage('Month is required')
        .isInt({ min: 1, max: 12 })
        .withMessage('Month must be between 1 and 12'),
    body('year')
        .notEmpty()
        .withMessage('Year is required')
        .isInt({ min: 2020, max: 2100 })
        .withMessage('Year must be between 2020 and 2100'),
    body('ratings')
        .isArray({ min: 1 })
        .withMessage('Ratings array is required and must contain at least one entry'),
    body('ratings.*.studentId')
        .notEmpty()
        .withMessage('Student ID is required')
        .isMongoId()
        .withMessage('Invalid student ID'),
    body('ratings.*.remarks')
        .optional()
        .isString()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Remarks cannot exceed 500 characters'),
    body('ratings.*.isExempt')
        .optional()
        .isBoolean(),
    body('ratings.*.exemptionReason')
        .optional()
        .isString()
        .trim(),
    ...ratingFieldValidation('classEngagement', 'Class Engagement'),
    ...ratingFieldValidation('homeworkClasswork', 'Homework & Classwork'),
    ...ratingFieldValidation('behaviourSocial', 'Behaviour & Social Skills'),
    ...ratingFieldValidation('englishComm', 'English/Subject Communication')
];

/**
 * Validation rules for admin bulk deletion of ratings for a subject, class, or entire month.
 * Accepts parameters in body or query parameters (in case proxy strips DELETE body).
 */
const adminBulkDeleteValidation = [
    check('subjectId')
        .optional()
        .isMongoId()
        .withMessage('Invalid subject ID'),
    check('classId')
        .optional()
        .isMongoId()
        .withMessage('Invalid class ID'),
    check('allInMonth')
        .optional()
        .custom((val) => {
            if (val === true || val === 'true' || val === false || val === 'false') return true;
            throw new Error('allInMonth must be a boolean');
        }),
    check().custom((val, { req }) => {
        const bodyObj = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
        const subjectId = bodyObj.subjectId || req.query?.subjectId;
        const classId = bodyObj.classId || req.query?.classId;
        const allInMonth = bodyObj.allInMonth ?? (req.query?.allInMonth === 'true' || req.query?.allInMonth === true);
        if (!subjectId && !classId && !allInMonth) {
            throw new Error('Either subjectId, classId, or allInMonth is required');
        }
        return true;
    }),
    check('month')
        .notEmpty()
        .withMessage('Month is required')
        .isInt({ min: 1, max: 12 })
        .withMessage('Month must be between 1 and 12'),
    check('year')
        .notEmpty()
        .withMessage('Year is required')
        .isInt({ min: 2020, max: 2100 })
        .withMessage('Year must be between 2020 and 2100'),
    check('reason')
        .optional()
        .isString()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Reason cannot exceed 500 characters')
];

/**
 * Validation rules for admin shifting ratings from one month to another (by subject, class, or entire month).
 */
const adminShiftMonthValidation = [
    check('subjectId')
        .optional()
        .isMongoId()
        .withMessage('Invalid subject ID'),
    check('classId')
        .optional()
        .isMongoId()
        .withMessage('Invalid class ID'),
    check('allInMonth')
        .optional()
        .custom((val) => {
            if (val === true || val === 'true' || val === false || val === 'false') return true;
            throw new Error('allInMonth must be a boolean');
        }),
    check().custom((val, { req }) => {
        const bodyObj = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
        const subjectId = bodyObj.subjectId || req.query?.subjectId;
        const classId = bodyObj.classId || req.query?.classId;
        const allInMonth = bodyObj.allInMonth ?? (req.query?.allInMonth === 'true' || req.query?.allInMonth === true);
        if (!subjectId && !classId && !allInMonth) {
            throw new Error('Either subjectId, classId, or allInMonth is required');
        }
        return true;
    }),
    check('sourceMonth')
        .notEmpty()
        .withMessage('Source month is required')
        .isInt({ min: 1, max: 12 })
        .withMessage('Source month must be between 1 and 12'),
    check('sourceYear')
        .notEmpty()
        .withMessage('Source year is required')
        .isInt({ min: 2020, max: 2100 })
        .withMessage('Source year must be between 2020 and 2100'),
    check('targetMonth')
        .notEmpty()
        .withMessage('Target month is required')
        .isInt({ min: 1, max: 12 })
        .withMessage('Target month must be between 1 and 12'),
    check('targetYear')
        .notEmpty()
        .withMessage('Target year is required')
        .isInt({ min: 2020, max: 2100 })
        .withMessage('Target year must be between 2020 and 2100'),
    check('overwriteTarget')
        .optional()
        .isBoolean()
        .withMessage('overwriteTarget must be a boolean'),
    check('reason')
        .optional()
        .isString()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Reason cannot exceed 500 characters')
];

/**
 * Validation rules for single student rating deletion.
 */
const singleStudentRatingDeleteValidation = [
    check('subjectId')
        .notEmpty()
        .withMessage('Subject ID is required')
        .isMongoId()
        .withMessage('Invalid subject ID'),
    check('month')
        .notEmpty()
        .withMessage('Month is required')
        .isInt({ min: 1, max: 12 })
        .withMessage('Month must be between 1 and 12'),
    check('year')
        .notEmpty()
        .withMessage('Year is required')
        .isInt({ min: 2020, max: 2100 })
        .withMessage('Year must be between 2020 and 2100')
];

module.exports = {
    bulkRatingValidation,
    adminBulkDeleteValidation,
    adminShiftMonthValidation,
    singleStudentRatingDeleteValidation
};
