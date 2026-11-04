const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const AcademicYear = require('../../src/models/AcademicYear');
const Attendance = require('../../src/models/Attendance');
const { invalidateUserCache } = require('../../src/middleware/auth');

describe('Attendance API Routes (/api/attendance)', () => {
  let unassignedTeacherToken;
  let assignedTeacherToken;
  let testClass;
  let student;
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

    const assignedTeacher = await User.create({
      name: 'Class Teacher',
      phone: '9876543220',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0
    });
    assignedTeacherToken = jwt.sign(
      { userId: assignedTeacher._id, role: 'teacher', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    const unassignedTeacher = await User.create({
      name: 'Other Teacher',
      phone: '9876543221',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0
    });
    unassignedTeacherToken = jwt.sign(
      { userId: unassignedTeacher._id, role: 'teacher', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    testClass = await Class.create({
      name: 'Class 9B',
      value: '9',
      label: 'Class 9B',
      section: 'B',
      branch: 'Main',
      academicYear: academicYear._id,
      classTeacher: assignedTeacher._id
    });

    student = await User.create({
      name: 'Kavya Patil',
      phone: '9876543223',
      password: 'password123',
      role: 'student',
      currentClass: testClass._id,
      academicYear: academicYear._id,
      isActive: true,
      tokenVersion: 0
    });
  });

  describe('POST /api/attendance/mark', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app)
        .post('/api/attendance/mark')
        .send({
          classId: testClass._id,
          date: '2026-11-03',
          attendanceRecords: [{ studentId: student._id, status: 'present' }]
        });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when unassigned teacher tries to mark attendance', async () => {
      const res = await request(app)
        .post('/api/attendance/mark')
        .set('Authorization', `Bearer ${unassignedTeacherToken}`)
        .send({
          classId: testClass._id,
          date: '2026-11-03',
          attendanceRecords: [{ studentId: student._id, status: 'present' }]
        });

      expect(res.statusCode).toBe(403);
    });

    it('returns 400 when attempting to mark attendance on a Sunday in IST', async () => {
      // 2026-11-01 is Sunday
      const res = await request(app)
        .post('/api/attendance/mark')
        .set('Authorization', `Bearer ${assignedTeacherToken}`)
        .send({
          classId: testClass._id,
          date: '2026-11-01',
          attendanceRecords: [{ studentId: student._id, status: 'present' }]
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Sundays/i);
    });

    it('successfully records attendance when marked by assigned class teacher on a working weekday', async () => {
      // 2026-11-03 is Tuesday
      const res = await request(app)
        .post('/api/attendance/mark')
        .set('Authorization', `Bearer ${assignedTeacherToken}`)
        .send({
          classId: testClass._id,
          date: '2026-11-03',
          attendanceRecords: [{ studentId: student._id, status: 'present', remarks: 'On time' }]
        });

      expect(res.statusCode).toBe(200);

      // Verify database record was saved
      const saved = await Attendance.findOne({ user: student._id });
      expect(saved).not.toBeNull();
      expect(saved.status).toBe('present');
      expect(saved.remarks).toBe('On time');
    });
  });
});

