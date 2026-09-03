const express = require('express');
const router = express.Router();
const searchController = require('../controllers/searchController');
const { authenticateToken: auth, checkRole } = require('../middleware/auth');

const adminOnly = [auth, checkRole(['admin', 'super admin'])];

// Global search - all authenticated users (scoped by role inside controller)
router.get('/global', auth, searchController.globalSearch);

// Advanced filters - admin only
router.get('/students/filter', adminOnly, searchController.filterStudents);
router.get('/exams/filter', adminOnly, searchController.filterExams);
router.get('/complaints/filter', adminOnly, searchController.filterComplaints);

module.exports = router;
