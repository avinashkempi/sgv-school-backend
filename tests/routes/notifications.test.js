const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Notification = require('../../src/models/Notification');
const AcademicYear = require('../../src/models/AcademicYear');

// Mock Firebase notification service to prevent any outbound network attempt
jest.mock('../../src/services/notificationService', () => ({
  sendTargetedNotification: jest.fn().mockResolvedValue({ success: true, sent: 0 }),
}));

describe('Notifications API Routes (/api/notifications)', () => {
  let adminUser, studentUser;
  let adminToken, studentToken;
  let academicYear;

  beforeEach(async () => {
    academicYear = await AcademicYear.create({
      name: '2025-2026',
      startDate: new Date('2025-06-01'),
      endDate: new Date('2026-04-30'),
      isActive: true,
    });

    adminUser = await User.create({
      name: 'Admin Notifs',
      phone: '9888811101',
      password: 'password123',
      role: 'admin',
      isActive: true,
      tokenVersion: 0,
      academicYear: academicYear._id,
    });

    studentUser = await User.create({
      name: 'Student Notifs',
      phone: '9888811102',
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
    studentToken = jwt.sign(
      { userId: studentUser._id, phone: studentUser.phone, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
  });

  describe('GET /api/notifications', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/notifications');
      expect(res.status).toBe(401);
    });

    it('returns notifications addressed to the student or broadcast to all', async () => {
      // 1. Notification targeted specifically to student
      await Notification.create({
        title: 'Fee Reminder',
        message: 'Your term fee is due soon.',
        category: 'fee',
        recipient: studentUser._id,
      });

      // 2. Broadcast notification targeted to all students
      await Notification.create({
        title: 'School Sports Day',
        message: 'Sports meet will be held on Friday.',
        category: 'event',
        recipient: null,
        targetRole: 'all',
      });

      // 3. Notification targeted to teachers only (student should NOT see this)
      await Notification.create({
        title: 'Staff Meeting',
        message: 'Staff meeting in the conference room.',
        category: 'general',
        recipient: null,
        targetRole: 'teacher',
      });

      const res = await request(app)
        .get('/api/notifications')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.notifications)).toBe(true);
      expect(res.body.notifications.length).toBe(2);

      const titles = res.body.notifications.map((n) => n.title);
      expect(titles).toContain('Fee Reminder');
      expect(titles).toContain('School Sports Day');
      expect(titles).not.toContain('Staff Meeting');
    });
  });

  describe('GET /api/notifications/unread-count', () => {
    it('calculates unread count accurately for current user', async () => {
      await Notification.create({
        title: 'Unread 1',
        message: 'Message 1',
        recipient: studentUser._id,
        isRead: false,
      });
      await Notification.create({
        title: 'Unread 2',
        message: 'Message 2',
        recipient: studentUser._id,
        isRead: false,
      });
      await Notification.create({
        title: 'Already Read',
        message: 'Message 3',
        recipient: studentUser._id,
        isRead: true,
      });

      const res = await request(app)
        .get('/api/notifications/unread-count')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('unreadCount');
      expect(res.body.unreadCount).toBe(2);
    });
  });

  describe('PUT /api/notifications/:id/read', () => {
    it('marks an individual notification as read', async () => {
      const notif = await Notification.create({
        title: 'Homework Assigned',
        message: 'Complete chapter 4 exercises.',
        recipient: studentUser._id,
        isRead: false,
      });

      const res = await request(app)
        .put(`/api/notifications/${notif._id}/read`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ isRead: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.notification.isRead).toBe(true);

      const updated = await Notification.findById(notif._id);
      expect(updated.isRead).toBe(true);
    });

    it('returns 404 when notification does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await request(app)
        .put(`/api/notifications/${fakeId}/read`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ isRead: true });

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/notifications/mark-all-read', () => {
    it('marks all direct notifications as read and advances user watermark', async () => {
      await Notification.create({
        title: 'Notice 1',
        message: 'M1',
        recipient: studentUser._id,
        isRead: false,
      });
      await Notification.create({
        title: 'Notice 2',
        message: 'M2',
        recipient: studentUser._id,
        isRead: false,
      });

      const res = await request(app)
        .put('/api/notifications/mark-all-read')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const unreadCount = await Notification.countDocuments({
        recipient: studentUser._id,
        isRead: false,
      });
      expect(unreadCount).toBe(0);

      const userAfter = await User.findById(studentUser._id);
      expect(userAfter.lastNotificationReadAt).toBeDefined();
    });
  });

  describe('POST /api/notifications/send', () => {
    it('blocks student from sending notifications (403)', async () => {
      const res = await request(app)
        .post('/api/notifications/send')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          title: 'Fake Notice',
          message: 'Trying to broadcast',
        });

      expect(res.status).toBe(403);
    });

    it('allows admin to send and persist a broadcast notification', async () => {
      const res = await request(app)
        .post('/api/notifications/send')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Holiday Announcement',
          message: 'School will remain closed tomorrow on account of festival.',
          type: 'Event',
          category: 'event',
          priority: 'high',
          target: 'all',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.notification.title).toBe('Holiday Announcement');

      const saved = await Notification.findOne({ title: 'Holiday Announcement' });
      expect(saved).toBeTruthy();
      expect(saved.priority).toBe('high');
    });
  });

  describe('GET & PUT /api/notifications/preferences', () => {
    it('retrieves default notification preferences for user', async () => {
      const res = await request(app)
        .get('/api/notifications/preferences')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('preferences');
    });

    it('updates user notification preferences', async () => {
      const res = await request(app)
        .put('/api/notifications/preferences')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          categories: {
            fee: false,
            event: true,
            exam: true,
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.preferences.categories.fee).toBe(false);
    });
  });
});

