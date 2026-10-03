const { body } = require('express-validator');

const VALID_RATING_RANGE = { min: 1, max: 5 };

const ratingFieldValidation = (fieldName, label) => [
    body(`ratings.*.${fieldName}`)
        .notEmpty()
        .withMessage(`${label} is required`)
        .isInt(VALID_RATING_RANGE)
        .withMessage(`${label} must be a whole number between 1 and 5`)
];

/**
 * Validation rules for bulk student ratings submission.
 * Expects body: { subjectId, month, year, ratings: [{ studentId, classEngagement, homeworkClasswork, behaviourSocial, englishComm }] }
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
    ...ratingFieldValidation('classEngagement', 'Class Engagement'),
    ...ratingFieldValidation('homeworkClasswork', 'Homework & Classwork'),
    ...ratingFieldValidation('behaviourSocial', 'Behaviour & Social Skills'),
    ...ratingFieldValidation('englishComm', 'English Communication')
];

module.exports = {
    bulkRatingValidation
};
