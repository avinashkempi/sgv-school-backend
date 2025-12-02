const express = require('express');
const cors = require('cors');
const compression = require('compression');
const cron = require('node-cron');
const connectDB = require('./src/config/database');
const app = express();
const PORT = process.env.PORT || 10000;
require('dotenv').config()

// Connect to MongoDB
connectDB();

// Middleware
// Enable compression
app.use(compression());

// Enable CORS for all origins and methods
app.use(cors({
  origin: '*', // Allow all origins
  credentials: false,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  optionsSuccessStatus: 200
}));

app.use(express.json());

// Routes
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/events', require('./src/routes/events'));
app.use('/api/news', require('./src/routes/news'));
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

app.get('/', (req, res) => {
  res.send('Hello from Express Backend!');
});

// Cron job to delete notifications for past events daily at midnight
cron.schedule('0 0 * * *', async () => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Set to start of today

    // Find events where date is before today
    const pastEvents = await require('./src/models/Event').find({ date: { $lt: today } });

    if (pastEvents.length > 0) {
      const eventIds = pastEvents.map(event => event._id);

      // Delete notifications for these past events
      const deleteResult = await require('./src/models/Notification').deleteMany({ eventId: { $in: eventIds } });

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
