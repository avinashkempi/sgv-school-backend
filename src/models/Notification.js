const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  message: {
    type: String,
    required: [true, 'Notification message is required'],
    trim: true
  },
  type: {
    type: String,
    enum: ['General', 'Homework', 'Exam', 'Fee', 'Emergency', 'Event', 'Birthday'],
    default: 'General'
  },
  category: {
    type: String,
    enum: ['exam', 'fee', 'attendance', 'complaint', 'event', 'general', 'leave', 'announcement', 'birthday'],
    default: 'general'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null // null means broadcast to all (or filtered by other means)
  },
  targetClass: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Class',
    default: null
  },
  targetRole: {
    type: String,
    enum: ['all', 'student', 'teacher', 'staff', 'admin', 'super admin'],
    default: 'all'
  },
  sendToPublic: {
    type: Boolean,
    default: false,
    description: 'If true, send to both authenticated and public (non-logged-in) users. If false, only send to logged-in users.'
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: {
    type: Date,
    default: null
  },
  // Action button support
  actionType: {
    type: String,
    enum: ['none', 'navigate', 'external_link', 'approve', 'reject'],
    default: 'none'
  },
  actionData: {
    type: mongoose.Schema.Types.Mixed, // Can be route, URL, or any data
    default: null
  },
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event'
  },
  // Archive support
  isArchived: {
    type: Boolean,
    default: false
  },
  archivedAt: {
    type: Date,
    default: null
  },
  metadata: {
    type: Object
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for faster queries
notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ targetRole: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ category: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1, isArchived: 1, createdAt: -1 });
notificationSchema.index({ targetRole: 1, isRead: 1, isArchived: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
