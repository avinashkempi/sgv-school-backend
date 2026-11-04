const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const Subject = require('../../src/models/Subject');
const AcademicYear = require('../../src/models/AcademicYear');
const Exam = require('../../src/models/Exam');
const Marks = require('../../src/models/Marks');
const { invalidateUserCache } = require('../../src/middleware/auth');

describe('Marks API Routes (/api/marks)', () => {
  let subjectTeacher;
  let subjectTeacherToken;
  let unassignedTeacherToken;
  let student1Token;
  let student2Token;
  let student1;
  let student2;
  let testClass;
  let testSubject;
  let testExam;
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

    subjectTeacher = await User.create({
      name: 'Maths Teacher',
      phone: '9876543402',
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
      name: 'Civics Teacher',
      phone: '9876543403',
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
      name: 'Class 7C',
      value: '7',
      label: 'Class 7C',
      section: 'C',
      branch: 'Main',
      academicYear: academicYear._id
    });

    testSubject = await Subject.create({
      name: 'Mathematics',
      class: testClass._id,
      academicYear: academicYear._id,
      teachers: [subjectTeacher._id]
    });

    testExam = await Exam.create({
      name: 'FA1 Mathematics',
      class: testClass._id,
      subject: testSubject._id,
      academicYear: academicYear._id,
      standardizedType: 'FA1',
      totalMarks: 25,
      createdBy: subjectTeacher._id
    });

    student1 = await User.create({
      name: 'Arjun Verma',
      phone: '9876543404',
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
      name: 'Bhavna Sen',
      phone: '9876543405',
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

  describe('POST /api/marks (Single Student Marks Entry)', () => {
    it('returns 400 when marksObtained exceeds totalMarks', async () => {
      const res = await request(app)
        .post('/api/marks')
        .set('Authorization', `Bearer ${subjectTeacherToken}`)
        .send({
          examId: testExam._id,
          studentId: student1._id,
          marksObtained: 30 // Total is 25
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/between 0 and 25/i);
    });

    it('returns 400 when marksObtained is negative', async () => {
      const res = await request(app)
        .post('/api/marks')
        .set('Authorization', `Bearer ${subjectTeacherToken}`)
        .send({
          examId: testExam._id,
          studentId: student1._id,
          marksObtained: -5
        });

      expect(res.statusCode).toBe(400);
    });

    it('returns 403 when unassigned teacher tries to record marks', async () => {
      const res = await request(app)
        .post('/api/marks')
        .set('Authorization', `Bearer ${unassignedTeacherToken}`)
        .send({
          examId: testExam._id,
          studentId: student1._id,
          marksObtained: 20
        });

      expect(res.statusCode).toBe(403);
    });

    it('records valid marks and calculates percentage accurately', async () => {
      const res = await request(app)
        .post('/api/marks')
        .set('Authorization', `Bearer ${subjectTeacherToken}`)
        .send({
          examId: testExam._id,
          studentId: student1._id,
          marksObtained: 20,
          remarks: 'Good progress'
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.marksObtained).toBe(20);
      // 20/25 * 100 = 80.00%
      expect(res.body.percentage).toBe(80);

      const dbMarks = await Marks.findOne({ student: student1._id, exam: testExam._id });
      expect(dbMarks).not.toBeNull();
      expect(dbMarks.marksObtained).toBe(20);
    });

    it('updates existing marks without creating duplicate records', async () => {
      // First submission: 15 marks
      await request(app)
        .post('/api/marks')
        .set('Authorization', `Bearer ${subjectTeacherToken}`)
        .send({ examId: testExam._id, studentId: student1._id, marksObtained: 15 });

      // Second updated submission: 22 marks
      const res = await request(app)
        .post('/api/marks')
        .set('Authorization', `Bearer ${subjectTeacherToken}`)
        .send({ examId: testExam._id, studentId: student1._id, marksObtained: 22 });

      expect(res.statusCode).toBe(200);
      expect(res.body.marksObtained).toBe(22);

      const count = await Marks.countDocuments({ student: student1._id, exam: testExam._id });
      expect(count).toBe(1);
    });
  });

  describe('GET /api/marks/student/:studentId', () => {
    beforeEach(async () => {
      await Marks.create({
        student: student1._id,
        exam: testExam._id,
        marksObtained: 23,
        percentage: 92,
        enteredBy: subjectTeacher._id
      });
    });

    it('allows a student to view their own marks', async () => {
      const res = await request(app)
        .get(`/api/marks/student/${student1._id}`)
        .set('Authorization', `Bearer ${student1Token}`);

      expect(res.statusCode).toBe(200);
    });

    it('blocks a student from viewing another student marks (403)', async () => {
      const res = await request(app)
        .get(`/api/marks/student/${student1._id}`)
        .set('Authorization', `Bearer ${student2Token}`); // student2 trying to view student1

      expect(res.statusCode).toBe(403);
    });
  });
});
