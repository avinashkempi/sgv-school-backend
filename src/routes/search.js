const express = require('express');
const router = express.Router();
const searchController = require('../controllers/searchController');
const { authenticateToken: auth } = require('../middleware/auth');

// Global search - all authenticated users
router.get('/global', auth, searchController.globalSearch);

// Advanced filters - admin only
router.get('/students/filter', auth, searchController.filterStudents);
router.get('/exams/filter', auth, searchController.filterExams);
router.get('/complaints/filter', auth, searchController.filterComplaints);

module.exports = router;
