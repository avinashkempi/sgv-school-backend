const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const AcademicYear = require('../../src/models/AcademicYear');
const Attendance = require('../../src/models/Attendance');
const StudentFee = require('../../src/models/StudentFee');

describe('Dashboard API Routes (/api/dashboard)', () => {
  let activeYear;
  let adminUser, teacherUser, studentUser;
  let adminToken, teacherToken, studentToken;
  let sampleClass;

  beforeEach(async () => {
    // 1. Create active academic year
    activeYear = await AcademicYear.create({
      name: '2025-2026',
      startDate: new Date('2025-06-01'),
      endDate: new Date('2026-04-30'),
      isActive: true,
    });

    // 2. Create users
    adminUser = await User.create({
      name: 'Admin User',
      phone: '9888800001',
      password: 'password123',
      role: 'admin',
      isActive: true,
      tokenVersion: 0,
      academicYear: activeYear._id,
    });

    teacherUser = await User.create({
      name: 'Teacher User',
      phone: '9888800002',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0,
      academicYear: activeYear._id,
    });

    sampleClass = await Class.create({
      name: 'Grade 5',
      label: 'Grade 5-A',
      value: 'grade-5-a',
      section: 'A',
      academicYear: activeYear._id,
      classTeacher: teacherUser._id,
    });

    studentUser = await User.create({
      name: 'Student User',
      phone: '9888800003',
      password: 'password123',
      role: 'student',
      isActive: true,
      tokenVersion: 0,
      academicYear: activeYear._id,
      class: sampleClass._id,
      rollNumber: '05',
    });

    // Add student to class
    sampleClass.students = [studentUser._id];
    await sampleClass.save();

    // 3. Generate tokens
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

  describe('GET /api/dashboard/admin', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/dashboard/admin');
      expect(res.status).toBe(401);
    });

    it('returns 403 when accessed by non-admin roles', async () => {
      const studentRes = await request(app)
        .get('/api/dashboard/admin')
        .set('Authorization', `Bearer ${studentToken}`);
      expect(studentRes.status).toBe(403);

      const teacherRes = await request(app)
        .get('/api/dashboard/admin')
        .set('Authorization', `Bearer ${teacherToken}`);
      expect(teacherRes.status).toBe(403);
    });

    it('returns aggregated overview metrics for admin', async () => {
      const res = await request(app)
        .get('/api/dashboard/admin')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('overview');
      expect(res.body.overview.totalStudents).toBe(1);
      expect(res.body.overview.totalTeachers).toBe(1);
      expect(res.body).toHaveProperty('charts');
      expect(res.body.charts).toHaveProperty('attendance');
    });
  });

  describe('GET /api/dashboard/teacher', () => {
    it('returns 403 when accessed by a student', async () => {
      const res = await request(app)
        .get('/api/dashboard/teacher')
        .set('Authorization', `Bearer ${studentToken}`);
      expect(res.status).toBe(403);
    });

    it('returns teacher stats including assigned class overview', async () => {
      const res = await request(app)
        .get('/api/dashboard/teacher')
        .set('Authorization', `Bearer ${teacherToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('overview');
      expect(res.body.overview).toHaveProperty('classes');
      expect(Array.isArray(res.body.overview.classes)).toBe(true);
      expect(res.body.overview.classes.length).toBe(1);
      expect(res.body.overview.classes[0].name).toBe('Grade 5');
    });
  });

  describe('GET /api/dashboard/student', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/dashboard/student');
      expect(res.status).toBe(401);
    });

    it('returns student summary profile, attendance stats and fees', async () => {
      // Create student fee record
      await StudentFee.create({
        student: studentUser._id,
        academicYear: activeYear._id,
        totalFees: 15000,
        toPay: 15000,
        paidAmount: 5000,
        balance: 10000,
        status: 'partial',
      });

      const res = await request(app)
        .get('/api/dashboard/student')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('overview');
      expect(res.body.overview.totalFees).toBe(15000);
      expect(res.body.overview.toPay).toBe(15000);
      expect(res.body).toHaveProperty('charts');
      expect(res.body.charts).toHaveProperty('performanceTrend');
    });
  });
});
