const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Event title is required'],
    trim: true,
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  date: {
    type: Date,
    required: [true, 'Event date is required']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'Description cannot exceed 500 characters']
  },
  isSchoolEvent: {
    type: Boolean,
    default: false
  },
  isHoliday: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Event must be created by a user']
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Add indexes for common queries
eventSchema.index({ date: -1 });
eventSchema.index({ createdBy: 1 });
eventSchema.index({ isSchoolEvent: 1 });
eventSchema.index({ isHoliday: 1 });

module.exports = mongoose.model('Event', eventSchema);
