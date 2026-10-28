const { body } = require('express-validator');

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

module.exports = {
    bulkRatingValidation
};
