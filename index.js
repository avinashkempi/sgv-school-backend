const express = require('express');
const cors = require('cors');
const compression = require('compression');
const cron = require('node-cron');
const rateLimit = require('express-rate-limit');
const connectDB = require('./src/config/database');
const Event = require('./src/models/Event');
const Notification = require('./src/models/Notification');
const app = express();
const PORT = process.env.PORT || 10000;
require('dotenv').config()

// Trust the first proxy hop (Render's load balancer) so that
// express-rate-limit can correctly identify client IPs from X-Forwarded-For.
app.set('trust proxy', 1);

// Connect to MongoDB
connectDB();

// Middleware
// Enable compression
app.use(compression());

// Enable CORS for all origins — required because this is a React Native mobile app,
// not a browser SPA. Mobile clients don't enforce same-origin policy, and the API
// must be accessible from any device.
app.use(cors({
  origin: '*',
  credentials: false,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  optionsSuccessStatus: 200
}));

// Parse JSON with a 10MB body size limit to prevent oversized payloads
app.use(express.json({ limit: '10mb' }));

// Rate limiting on auth routes to prevent brute-force login attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // limit each IP to 15 login attempts per window
  message: { success: false, message: 'Too many login attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
app.use('/api/auth', authLimiter, require('./src/routes/auth'));
app.use('/api/events', require('./src/routes/events'));

app.use('/api/school-info', require('./src/routes/schoolInfo'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/fcm', require('./src/routes/fcm'));
app.use('/api/academic-year', require('./src/routes/academicYear'));
app.use('/api/classes', require('./src/routes/classes'));
app.use('/api/teachers', require('./src/routes/teachers'));
app.use('/api/attendance', require('./src/routes/attendance'));
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

// Cron job to delete notifications for past events daily at midnight
cron.schedule('0 0 * * *', async () => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const pastEvents = await Event.find({ date: { $lt: today } });

    if (pastEvents.length > 0) {
      const eventIds = pastEvents.map(event => event._id);
      const deleteResult = await Notification.deleteMany({ eventId: { $in: eventIds } });
      console.log(`🗑️ Deleted ${deleteResult.deletedCount} notifications for past events`);
    }
  } catch (error) {
    console.error('❌ Error in cron job:', error);
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
