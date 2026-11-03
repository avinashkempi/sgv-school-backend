const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { invalidateUserCache } = require('../src/middleware/auth');
const { invalidateYearCache } = require('../src/middleware/yearContext');
const { invalidateDashboardCaches } = require('../src/controllers/dashboardController');

let mongoServer;

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = 'test-jwt-secret-key-123456';
process.env.TZ = 'Asia/Kolkata';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterEach(async () => {
  invalidateUserCache();
  invalidateYearCache();
  await invalidateDashboardCaches();
  if (mongoose.connection.readyState === 1) {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
  }
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});
