const mongoose = require('mongoose');

const vibeLikeSchema = new mongoose.Schema({
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

// Compound unique index — 1 user can only like 1 vibe once
vibeLikeSchema.index({ vibe: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('VibeLike', vibeLikeSchema);
