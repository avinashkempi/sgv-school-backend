const express = require('express');
const { getLabels } = require('../controllers/labelsController');

const router = express.Router();

// GET /api/labels — Public endpoint, returns all UI labels
// Supports ?v=<version> for conditional fetching (304 Not Modified)
router.get('/', getLabels);

module.exports = router;
