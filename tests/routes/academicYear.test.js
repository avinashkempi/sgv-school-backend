const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const AcademicYear = require('../../src/models/AcademicYear');
const { invalidateUserCache } = require('../../src/middleware/auth');

describe('Academic Year API Routes (/api/academic-year)', () => {
  let adminToken;
  let superAdminToken;
  let studentToken;
  let activeYear;

  beforeEach(async () => {
    invalidateUserCache();

    activeYear = await AcademicYear.create({
      name: '2026-2027',
      startDate: new Date('2026-06-01'),
      endDate: new Date('2027-04-30'),
      isActive: true,
      status: 'current'
    });

    const studentUser = await User.create({
      name: 'Student One',
      phone: '9876543210',
      password: 'password123',
      role: 'student',
      isActive: true,
      tokenVersion: 0
    });
    studentToken = jwt.sign(
      { userId: studentUser._id, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    const adminUser = await User.create({
      name: 'Admin One',
      phone: '9876543211',
      password: 'password123',
      role: 'admin',
      isActive: true,
      tokenVersion: 0
    });
    adminToken = jwt.sign(
      { userId: adminUser._id, role: 'admin', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    const superAdminUser = await User.create({
      name: 'Super Admin',
      phone: '9876543212',
      password: 'password123',
      role: 'super admin',
      isActive: true,
      tokenVersion: 0
    });
    superAdminToken = jwt.sign(
      { userId: superAdminUser._id, role: 'super admin', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
  });

  describe('GET /api/academic-year', () => {
    it('returns 401 if unauthenticated', async () => {
      const res = await request(app).get('/api/academic-year');
      expect(res.statusCode).toBe(401);
    });

    it('returns list of academic years for authenticated users', async () => {
      const res = await request(app)
        .get('/api/academic-year')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].name).toBe('2026-2027');
    });
  });

  describe('POST /api/academic-year', () => {
    it('blocks student from creating an academic year (403)', async () => {
      const res = await request(app)
        .post('/api/academic-year')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          name: '2027-2028',
          startDate: '2027-06-01',
          endDate: '2028-04-30'
        });

      expect(res.statusCode).toBe(403);
    });

    it('allows admin to create a new academic year', async () => {
      const res = await request(app)
        .post('/api/academic-year')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: '2027-2028',
          startDate: '2027-06-01',
          endDate: '2028-04-30'
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.name).toBe('2027-2028');
      expect(res.body.isActive).toBe(false);
    });
  });

  describe('PUT /api/academic-year/:yearId/activate', () => {
    it('allows super admin to activate a year', async () => {
      const newYear = await AcademicYear.create({
        name: '2027-2028',
        startDate: new Date('2027-06-01'),
        endDate: new Date('2028-04-30'),
        isActive: false,
        status: 'draft'
      });

      const res = await request(app)
        .put(`/api/academic-year/${newYear._id}/activate`)
        .set('Authorization', `Bearer ${superAdminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      const refreshed = await AcademicYear.findById(newYear._id);
      expect(refreshed.isActive).toBe(true);
      expect(refreshed.status).toBe('current');
    });
  });
});

