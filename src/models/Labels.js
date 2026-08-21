const mongoose = require('mongoose');

const labelsSchema = new mongoose.Schema({
  // Each top-level key is a label group (e.g. 'common', 'login', 'menu', 'teacher', etc.)
  // Using Mixed type for maximum flexibility — the structure is enforced by the seed script
  // and the frontend defaults file, not by the schema.
  labels: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    default: {}
  },
  version: {
    type: Number,
    default: 1,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

labelsSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Labels', labelsSchema);
