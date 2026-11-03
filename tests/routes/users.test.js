const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const AcademicYear = require('../../src/models/AcademicYear');
const { invalidateUserCache } = require('../../src/middleware/auth');

describe('User Management API Routes (/api/users)', () => {
  let adminToken;
  let teacherToken;
  let student1Token;
  let student2Token;
  let student1;
  let student2;
  let testClass;
  let academicYear;

  beforeEach(async () => {
    invalidateUserCache();

    academicYear = await AcademicYear.create({
      name: '2026-2027',
      startDate: new Date('2026-06-01'),
      endDate: new Date('2027-04-30'),
      isActive: true,
      status: 'current'
    });

    const admin = await User.create({
      name: 'Principal Sharma',
      phone: '9876543601',
      password: 'password123',
      role: 'admin',
      isActive: true,
      tokenVersion: 0
    });
    adminToken = jwt.sign(
      { userId: admin._id, role: 'admin', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    const teacher = await User.create({
      name: 'Pooja Reddy',
      phone: '9876543602',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0
    });
    teacherToken = jwt.sign(
      { userId: teacher._id, role: 'teacher', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    testClass = await Class.create({
      name: 'Class 5A',
      value: '5',
      label: 'Class 5A',
      section: 'A',
      branch: 'Main',
      academicYear: academicYear._id
    });

    student1 = await User.create({
      name: 'Vikas Nair',
      phone: '9876543603',
      password: 'password123',
      role: 'student',
      currentClass: testClass._id,
      academicYear: academicYear._id,
      isActive: true,
      tokenVersion: 0
    });
    student1Token = jwt.sign(
      { userId: student1._id, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    student2 = await User.create({
      name: 'Neha Kulkarni',
      phone: '9876543604',
      password: 'password123',
      role: 'student',
      currentClass: testClass._id,
      academicYear: academicYear._id,
      isActive: true,
      tokenVersion: 0
    });
    student2Token = jwt.sign(
      { userId: student2._id, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
  });

  describe('POST /api/users (Create User)', () => {
    it('blocks non-admin users from creating accounts (403)', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({
          name: 'New Student',
          phone: '9876543699',
          password: 'password123',
          role: 'student'
        });

      expect(res.statusCode).toBe(403);
    });

    it('rejects invalid Indian phone number format (400)', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Invalid Phone User',
          phone: '12345', // Invalid
          password: 'password123',
          role: 'student'
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('successfully creates student with valid details and hashes/stores properly', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Ananya Deshmukh',
          phone: '9876543610',
          password: 'securepassword',
          role: 'student',
          currentClass: testClass._id
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.user.name).toBe('Ananya Deshmukh');
      expect(res.body.user.role).toBe('student');

      const savedUser = await User.findOne({ phone: '9876543610' });
      expect(savedUser).not.toBeNull();
      expect(savedUser.isActive).toBe(true);
    });
  });

  describe('GET /api/users (Listing & Filtering)', () => {
    it('allows admin to list users with pagination', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(4);
    });

    it('blocks student from querying user directory (403)', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${student1Token}`);

      expect(res.statusCode).toBe(403);
    });

    it('allows teacher to list users when filtered by role=student', async () => {
      const res = await request(app)
        .get('/api/users?role=student')
        .set('Authorization', `Bearer ${teacherToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.every(u => u.role === 'student')).toBe(true);
    });
  });

  describe('GET /api/users/:id (Profile Access)', () => {
    it('allows a student to fetch their own profile details', async () => {
      const res = await request(app)
        .get(`/api/users/${student1._id}`)
        .set('Authorization', `Bearer ${student1Token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.name).toBe('Vikas Nair');
    });

    it('blocks a student from viewing another student profile (403)', async () => {
      const res = await request(app)
        .get(`/api/users/${student2._id}`)
        .set('Authorization', `Bearer ${student1Token}`); // student1 accessing student2

      expect(res.statusCode).toBe(403);
    });
  });

  describe('PUT /api/users/:id & DELETE /api/users/:id', () => {
    it('allows admin to update user details', async () => {
      const res = await request(app)
        .put(`/api/users/${student1._id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Vikas Narendra Nair',
          address: 'Main Street Hubballi'
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      const refreshed = await User.findById(student1._id);
      expect(refreshed.name).toBe('Vikas Narendra Nair');
    });

    it('allows admin to delete a user', async () => {
      const res = await request(app)
        .delete(`/api/users/${student2._id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      const deleted = await User.findById(student2._id);
      expect(deleted).toBeNull();
    });
  });
});
