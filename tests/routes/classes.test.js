const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const AcademicYear = require('../../src/models/AcademicYear');
const { invalidateUserCache } = require('../../src/middleware/auth');

describe('Classes API Routes (/api/classes)', () => {
  let superAdminToken;
  let teacherToken;
  let studentToken;
  let teacherUser;
  let studentUser;
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

    const superAdmin = await User.create({
      name: 'Super Admin User',
      phone: '9876543701',
      password: 'password123',
      role: 'super admin',
      isActive: true,
      tokenVersion: 0
    });
    superAdminToken = jwt.sign(
      { userId: superAdmin._id, role: 'super admin', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    teacherUser = await User.create({
      name: 'Suresh Patil',
      phone: '9876543702',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0
    });
    teacherToken = jwt.sign(
      { userId: teacherUser._id, role: 'teacher', tokenVersion: 0 },
      process.env.JWT_SECRET
    );

    studentUser = await User.create({
      name: 'Meena Roy',
      phone: '9876543703',
      password: 'password123',
      role: 'student',
      academicYear: academicYear._id,
      isActive: true,
      tokenVersion: 0
    });
    studentToken = jwt.sign(
      { userId: studentUser._id, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
  });

  describe('POST /api/classes (Create Class)', () => {
    it('blocks regular teachers from creating classes (403)', async () => {
      const res = await request(app)
        .post('/api/classes')
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({
          name: 'Class 4',
          section: 'A',
          branch: 'Main'
        });

      expect(res.statusCode).toBe(403);
    });

    it('allows super admin to create a new class and assign class teacher', async () => {
      const res = await request(app)
        .post('/api/classes')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          name: 'Class 4',
          section: 'A',
          branch: 'Main',
          classTeacher: teacherUser._id
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.value).toBe('class_4');
      expect(res.body.section).toBe('A');

      const saved = await Class.findOne({ value: 'class_4', section: 'A' });
      expect(saved).not.toBeNull();
      expect(saved.classTeacher.toString()).toBe(teacherUser._id.toString());
    });
  });

  describe('GET /api/classes & GET /api/classes/:id', () => {
    let testClass;

    beforeEach(async () => {
      testClass = await Class.create({
        name: 'Class 3B',
        value: '3',
        label: 'Class 3B',
        section: 'B',
        branch: 'Main',
        academicYear: academicYear._id,
        classTeacher: teacherUser._id
      });
    });

    it('returns list of classes for authenticated users', async () => {
      const res = await request(app)
        .get('/api/classes')
        .set('Authorization', `Bearer ${teacherToken}`);

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('returns single class details by ID', async () => {
      const res = await request(app)
        .get(`/api/classes/${testClass._id}`)
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.statusCode).toBe(200);
      expect(res.body._id).toBe(testClass._id.toString());
      expect(res.body.label).toBe('Class 3B');
    });

    it('enrolls student into the class via POST /api/classes/:id/students', async () => {
      const res = await request(app)
        .post(`/api/classes/${testClass._id}/students`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ studentId: studentUser._id });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      const refreshedStudent = await User.findById(studentUser._id);
      expect(refreshedStudent.currentClass.toString()).toBe(testClass._id.toString());
    });
  });
});
