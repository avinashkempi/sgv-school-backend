const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authenticateToken, checkRole } = require('../middleware/auth');
const { yearContext } = require('../middleware/yearContext');

router.get('/admin', [authenticateToken, checkRole(['admin', 'super admin']), yearContext], dashboardController.getAdminStats);
router.get('/teacher', [authenticateToken, checkRole(['teacher', 'staff', 'support_staff']), yearContext], dashboardController.getTeacherStats);
router.get('/student', [authenticateToken, checkRole(['student']), yearContext], dashboardController.getStudentStats);

module.exports = router;

