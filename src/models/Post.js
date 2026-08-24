const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Post title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  category: {
    type: String,
    enum: ['general', 'achievement'],
    required: [true, 'Category is required']
  },
  imageUrls: [{
    type: String,
    trim: true
  }],
  postedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isPinned: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Compound index: category + active + pinned + date for the main feed query
postSchema.index({ category: 1, isActive: 1, isPinned: -1, createdAt: -1 });
// Index for admin listing all posts
postSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);
