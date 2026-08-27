const mongoose = require('mongoose');

const vibeCommentSchema = new mongoose.Schema({
  vibe: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vibe',
    required: true,
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  text: {
    type: String,
    required: [true, 'Comment text is required'],
    trim: true,
    maxlength: [600, 'Comment cannot exceed 600 characters']
  },
  postAs: {
    type: String,
    enum: ['school', 'self'],
    default: 'self'
  },
  parentComment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VibeComment',
    default: null
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  likesCount: {
    type: Number,
    default: 0,
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

vibeCommentSchema.index({ vibe: 1, isActive: 1, createdAt: -1 });

module.exports = mongoose.model('VibeComment', vibeCommentSchema);
