const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Event = require('../../src/models/Event');
const Notification = require('../../src/models/Notification');
const Attendance = require('../../src/models/Attendance');
const AcademicYear = require('../../src/models/AcademicYear');

// Mock notification push service
jest.mock('../../src/services/notificationService', () => ({
  sendTargetedNotification: jest.fn().mockResolvedValue({ success: true }),
}));

describe('Events API Routes (/api/events)', () => {
  let adminUser, teacherUser, studentUser;
  let adminToken, teacherToken, studentToken;
  let academicYear;

  beforeEach(async () => {
    academicYear = await AcademicYear.create({
      name: '2025-2026',
      startDate: new Date('2025-06-01'),
      endDate: new Date('2026-04-30'),
      isActive: true,
    });

    adminUser = await User.create({
      name: 'Admin Events',
      phone: '9888822201',
      password: 'password123',
      role: 'admin',
      isActive: true,
      tokenVersion: 0,
      academicYear: academicYear._id,
    });

    teacherUser = await User.create({
      name: 'Teacher Events',
      phone: '9888822202',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0,
      academicYear: academicYear._id,
    });

    studentUser = await User.create({
      name: 'Student Events',
      phone: '9888822203',
      password: 'password123',
      role: 'student',
      isActive: true,
      tokenVersion: 0,
      academicYear: academicYear._id,
    });

    adminToken = jwt.sign(
      { userId: adminUser._id, phone: adminUser.phone, role: 'admin', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
    teacherToken = jwt.sign(
      { userId: teacherUser._id, phone: teacherUser.phone, role: 'teacher', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
    studentToken = jwt.sign(
      { userId: studentUser._id, phone: studentUser.phone, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
  });

  describe('GET /api/events', () => {
    it('is publicly accessible and returns list of events', async () => {
      await Event.create({
        title: 'Science Fair',
        date: new Date('2026-03-15T09:00:00.000Z'),
        isSchoolEvent: true,
        createdBy: adminUser._id,
      });

      const res = await request(app).get('/api/events');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.event)).toBe(true);
      expect(res.body.event.length).toBe(1);
      expect(res.body.event[0].title).toBe('Science Fair');
    });

    it('returns event by ID and 404 for invalid ID', async () => {
      const event = await Event.create({
        title: 'Annual Day',
        date: new Date('2026-04-10T10:00:00.000Z'),
        isSchoolEvent: true,
        createdBy: adminUser._id,
      });

      const foundRes = await request(app).get(`/api/events/${event._id}`);
      expect(foundRes.status).toBe(200);
      expect(foundRes.body.event.title).toBe('Annual Day');

      const fakeId = new mongoose.Types.ObjectId();
      const notFoundRes = await request(app).get(`/api/events/${fakeId}`);
      expect(notFoundRes.status).toBe(404);
    });
  });

  describe('POST /api/events', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).post('/api/events').send({
        title: 'Republic Day',
        date: '2026-01-26T00:00:00.000Z',
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when non-admin attempts to create event', async () => {
      const res = await request(app)
        .post('/api/events')
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({
          title: 'Class Party',
          date: '2026-02-14T00:00:00.000Z',
        });
      expect(res.status).toBe(403);
    });

    it('returns 400 when date is invalid or title is missing', async () => {
      const res = await request(app)
        .post('/api/events')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: '',
          date: 'not-a-valid-date',
        });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('creates an event, generates broadcast notification, and clears attendance on holidays', async () => {
      const holidayDate = '2026-08-15T00:00:00.000Z';

      // Pre-seed an attendance record on that date to verify holiday cleanup
      await Attendance.create({
        student: studentUser._id,
        user: studentUser._id,
        role: 'student',
        date: new Date(holidayDate),
        status: 'present',
        markedBy: teacherUser._id,
        academicYear: academicYear._id,
      });

      const res = await request(app)
        .post('/api/events')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Independence Day',
          date: holidayDate,
          description: 'Flag hoisting ceremony at 8:00 AM',
          isSchoolEvent: true,
          isHoliday: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.event.title).toBe('Independence Day');

      // Check notification auto-generation
      const eventId = res.body.event.id || res.body.event._id;
      const notif = await Notification.findOne({ eventId });
      expect(notif).toBeTruthy();
      expect(notif.type).toBe('Event');

      // Check attendance records on holiday date were deleted
      const remainingAttendance = await Attendance.countDocuments({
        date: new Date(holidayDate),
      });
      expect(remainingAttendance).toBe(0);
    });
  });

  describe('PUT /api/events/:id & DELETE /api/events/:id', () => {
    it('allows admin to update event details', async () => {
      const event = await Event.create({
        title: 'Sports Day Prelims',
        date: new Date('2026-02-10T00:00:00.000Z'),
        createdBy: adminUser._id,
      });

      const res = await request(app)
        .put(`/api/events/${event._id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Sports Day Finals',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const updated = await Event.findById(event._id);
      expect(updated.title).toBe('Sports Day Finals');
    });

    it('allows admin to delete an event and removes its associated notification', async () => {
      const event = await Event.create({
        title: 'Cancelled Workshop',
        date: new Date('2026-03-01T00:00:00.000Z'),
        createdBy: adminUser._id,
      });

      await Notification.create({
        title: 'Workshop',
        message: 'Upcoming workshop',
        eventId: event._id,
      });

      const res = await request(app)
        .delete(`/api/events/${event._id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const eventAfter = await Event.findById(event._id);
      expect(eventAfter).toBeNull();

      const notifAfter = await Notification.findOne({ eventId: event._id });
      expect(notifAfter).toBeNull();
    });
  });
});
