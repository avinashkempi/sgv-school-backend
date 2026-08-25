const mongoose = require('mongoose');

const vibeViewSchema = new mongoose.Schema({
  vibe: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vibe',
    required: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  viewedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound unique index — 1 user records 1 view record per vibe
vibeViewSchema.index({ user: 1, vibe: 1 }, { unique: true });
vibeViewSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('VibeView', vibeViewSchema);
