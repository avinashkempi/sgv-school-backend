const express = require('express');
const { createEventValidation, updateEventValidation } = require('../validations/events');
const { createEvent, getEventById, updateEvent, deleteEvent,getEvent } = require('../controllers/eventController');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// POST /api/events - Add a new event and create a notification immediately (admin only)
router.post('/', authenticateToken, requireAdmin, createEventValidation, createEvent);

// GET /api/events/:id - Get a specific event by ID (accessible to all authenticated and public users)
router.get('/:id', getEventById);

// Get all the events (public - no authentication required)
router.get('/', getEvent);

// PUT /api/events/:id - Update a specific event by ID (admin only)
router.put('/:id', authenticateToken, requireAdmin, updateEventValidation, updateEvent);

// DELETE /api/events/:id - Delete an event and its associated notifications (admin only)
router.delete('/:id', authenticateToken, requireAdmin, deleteEvent);

module.exports = router;
