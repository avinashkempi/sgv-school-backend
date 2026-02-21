const express = require('express');
const router = express.Router();
const academicYearController = require('../controllers/academicYearController');
const { authenticateToken: auth, checkRole } = require('../middleware/auth');

// @route   GET /api/academic-year
// @desc    Get all academic years
// @access  Private
router.get('/', auth, academicYearController.getAllYears);

// @route   POST /api/academic-year
// @desc    Create a new academic year
// @access  Admin/Super Admin
router.post('/', [auth, checkRole(['admin', 'super admin'])], academicYearController.createYear);

// @route   GET /api/academic-year/dashboard
// @desc    Get dashboard data for all years
// @access  Super Admin
router.get('/dashboard', [auth, checkRole(['super admin'])], academicYearController.getDashboardData);

// @route   GET /api/academic-year/compare
// @desc    Compare multiple years
// @access  Super Admin
router.get('/compare', [auth, checkRole(['super admin'])], academicYearController.compareYears);

// @route   POST /api/academic-year/transition/preview
// @desc    Preview year transition impact
// @access  Super Admin
router.post('/transition/preview', [auth, checkRole(['super admin'])], academicYearController.previewTransition);

// @route   GET /api/academic-year/:yearId/transition/validate
// @desc    Generate pre-flight validation warnings
// @access  Super Admin
router.get('/:yearId/transition/validate', [auth, checkRole(['super admin'])], academicYearController.validateTransition);

// @route   POST /api/academic-year/transition/execute
// @desc    Execute year transition
// @access  Super Admin
router.post('/transition/execute', [auth, checkRole(['super admin'])], academicYearController.executeTransition);

// @route   POST /api/academic-year/transition/rollback
// @desc    Rollback year transition
// @access  Super Admin
router.post('/transition/rollback', [auth, checkRole(['super admin'])], academicYearController.rollbackTransition);

// @route   POST /api/academic-year/increment
// @desc    Increment Academic Year (Promote Students) - LEGACY
// @access  Super Admin
router.post('/increment', [auth, checkRole(['super admin'])], academicYearController.incrementYear);

// @route   GET /api/academic-year/:yearId/comprehensive-report
// @desc    Get comprehensive report for an academic year
// @access  Super Admin
router.get('/:yearId/comprehensive-report', [auth, checkRole(['super admin'])], academicYearController.getComprehensiveReport);

// @route   GET /api/academic-year/:academicYearId/reports
// @desc    Get reports for an academic year - LEGACY
// @access  Super Admin
router.get('/:academicYearId/reports', [auth, checkRole(['super admin'])], academicYearController.getReports);

module.exports = router;
