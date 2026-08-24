const mongoose = require('mongoose');

const schoolInfoSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'School name is required'],
    trim: true
  },
  address: {
    type: String,
    required: [true, 'Address is required'],
    trim: true
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    trim: true,
    lowercase: true
  },
  mapUrl: {
    type: String,
    trim: true
  },
  mapAppUrl: {
    type: String,
    trim: true
  },
  mission: {
    type: String,
    trim: true
  },
  about: {
    type: String,
    trim: true
  },
  socials: {
    instagram: {
      type: String,
      trim: true
    },
    instagramAppUrl: {
      type: String,
      trim: true
    },
    youtube: {
      type: String,
      trim: true
    },
    youtubeAppUrl: {
      type: String,
      trim: true
    }
  },
  news: [{
    id: {
      type: String,
      required: true
    },
    date: {
      type: String,
      required: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    }
  }],
  photoUrl: [{
    type: String,
    trim: true
  }],
  photoUrls: [{
    type: String,
    trim: true
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt field before saving
schoolInfoSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('SchoolInfo', schoolInfoSchema);
