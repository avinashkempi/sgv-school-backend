const mongoose = require('mongoose');

const vibeBookmarkSchema = new mongoose.Schema({
  vibe: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vibe',
    required: true,
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  }
}, {
  timestamps: true
});

vibeBookmarkSchema.index({ user: 1, vibe: 1 }, { unique: true });
vibeBookmarkSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('VibeBookmark', vibeBookmarkSchema);
