const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const Subject = require('../../src/models/Subject');
const AcademicYear = require('../../src/models/AcademicYear');
const Exam = require('../../src/models/Exam');
const { invalidateUserCache } = require('../../src/middleware/auth');

describe('Exams API Routes (/api/exams)', () => {
  let adminToken;
  let subjectTeacherToken;
  let unassignedTeacherToken;
  let testClass;
  let testSubject;
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
      name: 'Admin Head',
      phone: '9876543301',
      password: 'password123',
      role: 'admin',
      isActive: true,
      tokenVersion: 0
    });
    adminToken = jwt.sign(
      { userId: admin._id, role: 'admin', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    const subjectTeacher = await User.create({
      name: 'Science Teacher',
      phone: '9876543302',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0
    });
    subjectTeacherToken = jwt.sign(
      { userId: subjectTeacher._id, role: 'teacher', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    const unassignedTeacher = await User.create({
      name: 'History Teacher',
      phone: '9876543303',
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
      name: 'Class 8A',
      value: '8',
      label: 'Class 8A',
      section: 'A',
      branch: 'Main',
      academicYear: academicYear._id
    });

    testSubject = await Subject.create({
      name: 'General Science',
      class: testClass._id,
      academicYear: academicYear._id,
      teachers: [subjectTeacher._id]
    });
  });

  describe('POST /api/exams/standardized', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app)
        .post('/api/exams/standardized')
        .send({
          type: 'FA1',
          classId: testClass._id,
          subjectId: testSubject._id,
          totalMarks: 25
        });

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for invalid standardized exam type', async () => {
      const res = await request(app)
        .post('/api/exams/standardized')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'INVALID_TYPE',
          classId: testClass._id,
          subjectId: testSubject._id,
          totalMarks: 25
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/Invalid exam type/i);
    });

    it('returns 403 when unassigned teacher tries to initialize exam', async () => {
      const res = await request(app)
        .post('/api/exams/standardized')
        .set('Authorization', `Bearer ${unassignedTeacherToken}`)
        .send({
          type: 'FA1',
          classId: testClass._id,
          subjectId: testSubject._id,
          totalMarks: 25
        });

      expect(res.statusCode).toBe(403);
    });

    it('creates standardized exam when initiated by subject teacher', async () => {
      const res = await request(app)
        .post('/api/exams/standardized')
        .set('Authorization', `Bearer ${subjectTeacherToken}`)
        .send({
          type: 'FA1',
          classId: testClass._id,
          subjectId: testSubject._id,
          totalMarks: 25,
          duration: 45
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.standardizedType).toBe('FA1');
      expect(res.body.term).toBe('1st term');
      expect(res.body.totalMarks).toBe(25);

      const dbExam = await Exam.findOne({ class: testClass._id, subject: testSubject._id, standardizedType: 'FA1' });
      expect(dbExam).not.toBeNull();
    });

    it('returns 400 when attempting to create duplicate standardized exam', async () => {
      // First creation
      await request(app)
        .post('/api/exams/standardized')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'FA1',
          classId: testClass._id,
          subjectId: testSubject._id,
          totalMarks: 25
        });

      // Second duplicate creation
      const res = await request(app)
        .post('/api/exams/standardized')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'FA1',
          classId: testClass._id,
          subjectId: testSubject._id,
          totalMarks: 25
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/already exists/i);
    });
  });

  describe('GET /api/exams/standardized', () => {
    it('returns 400 when classId or subjectId is missing', async () => {
      const res = await request(app)
        .get('/api/exams/standardized')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.statusCode).toBe(400);
    });

    it('returns status list for all 6 standardized exam types', async () => {
      // Create FA1
      await Exam.create({
        name: 'FA1 Science',
        class: testClass._id,
        subject: testSubject._id,
        academicYear: academicYear._id,
        standardizedType: 'FA1',
        totalMarks: 25,
        createdBy: testSubject.teachers[0]
      });

      const res = await request(app)
        .get(`/api/exams/standardized?classId=${testClass._id}&subjectId=${testSubject._id}`)
        .set('Authorization', `Bearer ${subjectTeacherToken}`);

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(6);

      const fa1Entry = res.body.find(e => e.type === 'FA1');
      expect(fa1Entry.exists).toBe(true);

      const sa1Entry = res.body.find(e => e.type === 'SA1');
      expect(sa1Entry.exists).toBe(false);
    });
  });
});
