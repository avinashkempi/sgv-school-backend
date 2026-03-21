const { validationResult } = require('express-validator');
const Event = require('../models/Event');
const Notification = require('../models/Notification');
const { sendTargetedNotification } = require('../services/notificationService');

const createEvent = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { title, date, description, isSchoolEvent } = req.body;

    // Create new event
    const event = new Event({
      title,
      date,
      description,
      isSchoolEvent: isSchoolEvent !== undefined ? isSchoolEvent : false,
      createdBy: req.user.userId
    });
    await event.save();

    // Immediately create a notification for the new event
    const notificationTitle = title ? `New Event: ${title}` : 'New Event';
    const notification = new Notification({
      title: notificationTitle,
      message: `New event added: ${title || 'Untitled'} on ${new Date(date).toDateString()}`,
      type: 'Event',
      category: 'event',
      targetRole: 'all',
      eventId: event._id
    });
    await notification.save();

    // Trigger Push Notification
    await sendTargetedNotification('all', null, {
      title: 'New Event: ' + title,
      message: `A new event "${title}" has been scheduled for ${new Date(date).toDateString()}.`,
      type: 'Event',
      eventId: event._id
    });

    res.status(201).json({
      success: true,
      message: 'Event created and notification sent',
      event: {
        id: event._id,
        title: event.title,
        date: event.date,
        description: event.description,
        createdBy: event.createdBy
      },
      notification: {
        id: notification._id,
        message: notification.message,
        eventId: notification.eventId
      }
    });
  } catch (error) {
    console.error('Add event error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during event creation'
    });
  }
};

const getEventById = async (req, res) => {
  try {
    const eventId = req.params.id;

    // Find the event and check if it belongs to the user
    const event = await Event.findOne({ _id: eventId, createdBy: req.user.userId });
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found or you do not have permission to view it'
      });
    }

    res.json({
      success: true,
      event: {
        id: event._id,
        title: event.title,
        date: event.date,
        description: event.description,
        createdBy: event.createdBy,
        createdAt: event.createdAt
      }
    });
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during event retrieval'
    });
  }
};


const getEvent = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Build query
    const query = {};

    // Date range filter
    if (req.query.startDate || req.query.endDate) {
      query.date = {};
      if (req.query.startDate) query.date.$gte = new Date(req.query.startDate);
      if (req.query.endDate) query.date.$lte = new Date(req.query.endDate);
    }

    // School event filter
    if (req.query.isSchoolEvent !== undefined) {
      query.isSchoolEvent = req.query.isSchoolEvent === 'true';
    }

    const events = await Event.find(query)
      .sort({ date: -1 }) // Default sort by date descending
      .skip(skip)
      .limit(limit);

    const total = await Event.countDocuments(query);

    res.json({
      success: true,
      event: events,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit
      }
    });
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during event retrieval'
    });
  }
};

const updateEvent = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const eventId = req.params.id;
    const { title, date, description, isSchoolEvent } = req.body;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Update the event fields
    if (title !== undefined) event.title = title;
    if (date !== undefined) event.date = date;
    if (description !== undefined) event.description = description;
    if (isSchoolEvent !== undefined) event.isSchoolEvent = isSchoolEvent;

    await event.save();

    res.json({
      success: true,
      message: 'Event updated successfully',
      event: {
        id: event._id,
        title: event.title,
        date: event.date,
        description: event.description,
        createdBy: event.createdBy,
        createdAt: event.createdAt
      }
    });
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during event update'
    });
  }
};

const deleteEvent = async (req, res) => {
  try {
    const eventId = req.params.id;

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Delete the event
    await Event.findByIdAndDelete(eventId);

    // Delete associated notifications
    await Notification.deleteMany({ eventId });

    res.json({
      success: true,
      message: 'Event and associated notifications deleted successfully'
    });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during event deletion'
    });
  }
};

module.exports = {
  createEvent,
  getEventById,
  updateEvent,
  deleteEvent,
  getEvent
};
