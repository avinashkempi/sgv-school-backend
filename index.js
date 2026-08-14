const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const connectDB = require('./src/config/database');
const { startAllCronJobs } = require('./src/services/cronService');
const Event = require('./src/models/Event');
const Notification = require('./src/models/Notification');
const logger = require('./src/utils/logger');
const requestId = require('./src/middleware/requestId');
const requestLogger = require('./src/middleware/requestLogger');
const errorHandler = require('./src/middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 10000;
require('dotenv').config();

// Process-level unhandled error monitoring
process.on('uncaughtException', (err) => {
  logger.error('CRITICAL: Uncaught Exception detected in Node process', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('CRITICAL: Unhandled Promise Rejection detected', reason instanceof Error ? reason : { reason });
});

// Trust the first proxy hop (Render's load balancer) so that
// express-rate-limit can correctly identify client IPs from X-Forwarded-For.
app.set('trust proxy', 1);

// Enable strong ETag caching for bandwidth optimization
app.set('etag', 'strong');

// Connect to MongoDB
connectDB();

// Initialize Redis (optional with graceful fallback)
require('./src/config/redis');

// Request Tracking & Logging Middleware
app.use(requestId);
app.use(requestLogger);

// Middleware
// Enable compression
app.use(compression());

// Enable CORS for all origins — required because this is a React Native mobile app,
// not a browser SPA. Mobile clients don't enforce same-origin policy, and the API
// must be accessible from any device.
app.use(cors({
  origin: '*',
  credentials: false,
  allowedHeaders: ['Content-Type', 'Authorization', 'x-academic-year', 'x-request-id'],
  exposedHeaders: ['x-active-academic-year', 'x-request-id'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  optionsSuccessStatus: 200
}));

// Parse JSON with a 5MB body size limit to carefully reduce large payloads safely
app.use(express.json({ limit: '5mb' }));

// Rate limiting on auth routes to prevent brute-force login attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // limit each IP to 15 login attempts per window
  message: { success: false, message: 'Too many login attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API Rate Limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // limit each IP to 300 general requests per window
  message: { success: false, message: 'Too many requests from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
// Apply global api rate limiter to all api routes, auth will also get its own stricter limit
app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/webhooks', require('./src/routes/webhooks')); // Added decoupled Webhooks
app.use('/api/events', require('./src/routes/events'));

app.use('/api/school-info', require('./src/routes/schoolInfo'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/fcm', require('./src/routes/fcm'));
app.use('/api/academic-year', require('./src/routes/academicYear'));
app.use('/api/classes', require('./src/routes/classes'));
app.use('/api/teachers', require('./src/routes/teachers'));
app.use('/api/attendance', require('./src/routes/attendance'));
// Mount examsNew before exams to prevent /:id shadowing
app.use('/api/exams', require('./src/routes/exams'));
app.use('/api/marks', require('./src/routes/marks'));
app.use('/api/timetable', require('./src/routes/timetable'));
app.use('/api/leaves', require('./src/routes/leaves'));
app.use('/api/fees', require('./src/routes/fees'));
app.use('/api/complaints', require('./src/routes/complaints'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api/subjects', require('./src/routes/subjects'));
app.use('/api/reports', require('./src/routes/reports'));
app.use('/api/feedback', require('./src/routes/feedback'));
app.use('/api/dashboard', require('./src/routes/dashboardRoutes'));
app.use('/api/search', require('./src/routes/search'));
app.use('/api/attendance-enhancements', require('./src/routes/attendanceEnhancements'));
app.use('/api/fee-enhancements', require('./src/routes/feeEnhancements'));
app.use('/api/analytics', require('./src/routes/analytics'));
app.use('/api/import', require('./src/routes/import'));

app.get('/', (req, res) => {
  res.send('Hello from Express Backend!');
});

// Global Central Error Handler Middleware
app.use(errorHandler);

// Webhook routes handle tasks like cron previously handled locally

// Start the server
app.listen(PORT, () => {
  logger.info(`✅ Server running on http://localhost:${PORT}`);
  // Start background cron jobs
  startAllCronJobs();
});
