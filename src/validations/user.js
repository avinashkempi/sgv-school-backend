const { body } = require('express-validator');

const userValidation = [
  body('name')
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 3, max: 50 })
    .withMessage('Name must be between 3 and 50 characters')
    .matches(/^[a-zA-Z\s]+$/)
    .withMessage('Name must contain only letters and spaces'),
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Please provide a valid 10-digit Indian phone number (starting with 6-9)'),
  body('email')
    .optional({ checkFalsy: true })
    .isEmail()
    .withMessage('Please provide a valid email'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
  body('role')
    .optional()
    .isIn(['student', 'teacher', 'staff', 'admin', 'super admin'])
    .withMessage('Role must be one of: student, teacher, staff, admin, super admin'),
  body('guardianPhone')
    .optional({ checkFalsy: true })
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Please provide a valid 10-digit Indian phone number for guardian'),
  body('admissionDate')
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage('Admission date must be a valid date'),
  body('joiningDate')
    .optional({ checkFalsy: true })
    .isISO8601()
    .withMessage('Joining date must be a valid date')
];

module.exports = {
  userValidation
};
