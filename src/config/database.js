const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      logger.error('MONGODB_URI environment variable is not set');
      process.exit(1);
    }

    // Attach lifecycle event listeners to Mongoose connection
    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error event', err);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected from server');
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected successfully');
    });

    await mongoose.connect(process.env.MONGODB_URI, { 
      family: 4,
      maxPoolSize: 10,
      minPoolSize: 2
    });

    logger.info('✅ Connected to MongoDB successfully');
  } catch (err) {
    logger.error('❌ MongoDB initial connection failure', err);
    process.exit(1);
  }
};

module.exports = connectDB;
