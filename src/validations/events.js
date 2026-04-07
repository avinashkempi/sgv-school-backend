const { body } = require('express-validator');

const createEventValidation = [
  body('title')
    .isLength({ min: 1, max: 100 })
    .withMessage('Title must be between 1 and 100 characters'),
  body('date')
    .isISO8601()
    .withMessage('Please provide a valid date in ISO format'),
  body('description')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),
  body('isSchoolEvent')
    .optional()
    .isBoolean()
    .withMessage('isSchoolEvent must be a boolean value'),
  body('isHoliday')
    .optional()
    .isBoolean()
    .withMessage('isHoliday must be a boolean value')
];

const updateEventValidation = [
  body('title')
    .optional()
    .isLength({ min: 1, max: 100 })
    .withMessage('Title must be between 1 and 100 characters'),
  body('date')
    .optional()
    .isISO8601()
    .withMessage('Please provide a valid date in ISO format'),
  body('description')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Description cannot exceed 500 characters'),
  body('isSchoolEvent')
    .optional()
    .isBoolean()
    .withMessage('isSchoolEvent must be a boolean value'),
  body('isHoliday')
    .optional()
    .isBoolean()
    .withMessage('isHoliday must be a boolean value')
];

module.exports = {
  createEventValidation,
  updateEventValidation
};
