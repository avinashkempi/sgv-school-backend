const { validationResult } = require('express-validator');
const Event = require('../models/Event');
const Notification = require('../models/Notification');
const Attendance = require('../models/Attendance');
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

    const { title, date, description, isSchoolEvent, isHoliday } = req.body;

    // Create new event
    const event = new Event({
      title,
      date,
      description,
      isSchoolEvent: isSchoolEvent !== undefined ? isSchoolEvent : false,
      isHoliday: isHoliday !== undefined ? isHoliday : false,
      createdBy: req.user.userId
    });
    await event.save();

    // If it's a holiday, clear attendance for that day
    if (event.isHoliday) {
      const targetDate = new Date(date);
      targetDate.setHours(0, 0, 0, 0);
      const nextDay = new Date(targetDate);
      nextDay.setDate(targetDate.getDate() + 1);
      await Attendance.deleteMany({ date: { $gte: targetDate, $lt: nextDay } });
    }

    // Immediately create a notification for the new event
    const notificationTitle = `📅 New Event: ${title}`;
    const notification = new Notification({
      title: notificationTitle,
      message: `A new event "${title}" has been scheduled for ${new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}. Stay tuned for more details!`,
      type: 'Event',
      category: 'event',
      priority: 'medium',
      targetRole: 'all',
      eventId: event._id
    });
    await notification.save();

    // Trigger Push Notification
    await sendTargetedNotification('all', null, {
      title: `📅 New Event: ${title}`,
      message: `"${title}" has been scheduled for ${new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}. Mark your calendar!`,
      type: 'Event',
      category: 'event',
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
      if (req.query.startDate) {
        const start = new Date(req.query.startDate);
        start.setHours(0, 0, 0, 0);
        query.date.$gte = start;
      }
      if (req.query.endDate) {
        const end = new Date(req.query.endDate);
        end.setHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
    }

    // School event filter
    if (req.query.isSchoolEvent !== undefined) {
      query.isSchoolEvent = req.query.isSchoolEvent === 'true';
    }

    if (req.query.isHoliday !== undefined) {
      query.isHoliday = req.query.isHoliday === 'true';
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
    const { title, date, description, isSchoolEvent, isHoliday } = req.body;

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
    
    let becameHoliday = false;
    if (isHoliday !== undefined) {
      if (!event.isHoliday && isHoliday) becameHoliday = true;
      event.isHoliday = isHoliday;
    }

    await event.save();

    if (becameHoliday) {
      const targetDate = new Date(event.date);
      targetDate.setHours(0, 0, 0, 0);
      const nextDay = new Date(targetDate);
      nextDay.setDate(targetDate.getDate() + 1);
      await Attendance.deleteMany({ date: { $gte: targetDate, $lt: nextDay } });
    }

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
