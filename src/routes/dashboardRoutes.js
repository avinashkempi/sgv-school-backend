const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');
const { authenticateToken, checkRole } = require('../middleware/auth');

router.get('/admin', authenticateToken, checkRole(['admin', 'super admin']), dashboardController.getAdminStats);
router.get('/teacher', authenticateToken, checkRole(['teacher']), dashboardController.getTeacherStats);
router.get('/student', authenticateToken, checkRole(['student']), dashboardController.getStudentStats);

module.exports = router;
