const mongoose = require('mongoose');

const vibeSchema = new mongoose.Schema({
  caption: {
    type: String,
    trim: true,
    maxlength: [2200, 'Caption cannot exceed 2200 characters'],
    default: ''
  },
  category: {
    type: String,
    enum: ['general', 'achievement', 'life', 'sports', 'arts', 'official'],
    default: 'general'
  },
  images: [{
    url: {
      type: String,
      required: true,
      trim: true
    },
    publicId: {
      type: String,
      trim: true
    },
    width: {
      type: Number,
      default: 1080
    },
    height: {
      type: Number,
      default: 1080
    },
    aspectRatio: {
      type: Number,
      default: 1 // width / height (e.g. 1.0 for square, 0.8 for 4:5, 1.77 for 16:9)
    }
  }],
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  postAs: {
    type: String,
    enum: ['school', 'self'],
    default: 'self'
  },
  authorRole: {
    type: String,
    enum: ['student', 'teacher', 'staff', 'admin', 'super admin', 'support_staff', 'alumni'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  rejectionReason: {
    type: String,
    trim: true,
    maxlength: [500, 'Reason cannot exceed 500 characters']
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewedAt: {
    type: Date
  },
  likesCount: {
    type: Number,
    default: 0,
    min: 0
  },
  commentsCount: {
    type: Number,
    default: 0,
    min: 0
  },
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  location: {
    type: String,
    trim: true,
    maxlength: 100
  },
  isPinned: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Performance compound indexes
vibeSchema.index({ status: 1, isActive: 1, isPinned: -1, createdAt: -1 });
vibeSchema.index({ status: 1, category: 1, isActive: 1, isPinned: -1, createdAt: -1 });
vibeSchema.index({ author: 1, status: 1, isActive: 1, createdAt: -1 });
vibeSchema.index({ tags: 1, status: 1, isActive: 1 });

module.exports = mongoose.model('Vibe', vibeSchema);
