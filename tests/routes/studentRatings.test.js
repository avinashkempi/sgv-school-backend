const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const Subject = require('../../src/models/Subject');
const AcademicYear = require('../../src/models/AcademicYear');
const StudentRating = require('../../src/models/StudentRating');
const { getISTMonthYear } = require('../../src/utils/dateUtils');

describe('Student Self-Service Ratings API (/api/student-ratings/my-ratings)', () => {
  let activeYear;
  let teacherUser, studentUser1, studentUser2;
  let studentToken1;
  let sampleClass;
  let mathSubject, scienceSubject;

  beforeEach(async () => {
    // 1. Create active academic year
    activeYear = await AcademicYear.create({
      name: '2025-2026',
      startDate: new Date('2025-06-01'),
      endDate: new Date('2026-04-30'),
      isActive: true,
    });

    // 2. Create users
    teacherUser = await User.create({
      name: 'Teacher One',
      phone: '9888800101',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0,
      academicYear: activeYear._id,
    });

    sampleClass = await Class.create({
      name: 'Grade 6',
      label: 'Grade 6-A',
      value: 'grade-6-a',
      section: 'A',
      academicYear: activeYear._id,
      classTeacher: teacherUser._id,
    });

    studentUser1 = await User.create({
      name: 'Avinash Student',
      phone: '9888800102',
      password: 'password123',
      role: 'student',
      isActive: true,
      tokenVersion: 0,
      academicYear: activeYear._id,
      currentClass: sampleClass._id,
      class: sampleClass._id,
      rollNumber: '01',
    });

    studentUser2 = await User.create({
      name: 'Peer Student',
      phone: '9888800103',
      password: 'password123',
      role: 'student',
      isActive: true,
      tokenVersion: 0,
      academicYear: activeYear._id,
      currentClass: sampleClass._id,
      class: sampleClass._id,
      rollNumber: '02',
    });

    sampleClass.students = [studentUser1._id, studentUser2._id];
    await sampleClass.save();

    // 3. Create subjects
    mathSubject = await Subject.create({
      name: 'Mathematics',
      code: 'MATH6',
      class: sampleClass._id,
      academicYear: activeYear._id,
      ratingEnabled: true,
      teachers: [teacherUser._id],
    });

    scienceSubject = await Subject.create({
      name: 'Science',
      code: 'SCI6',
      class: sampleClass._id,
      academicYear: activeYear._id,
      ratingEnabled: true,
      teachers: [teacherUser._id],
    });

    // 4. Generate student tokens
    studentToken1 = jwt.sign(
      { userId: studentUser1._id, phone: studentUser1.phone, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
  });

  describe('GET /api/student-ratings/my-ratings', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/api/student-ratings/my-ratings');
      expect(res.status).toBe(401);
    });

    it('returns cumulative metrics, class comparison, and current month status', async () => {
      const { month: curMonth, year: curYear } = getISTMonthYear();
      const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
      const prevYear = curMonth === 1 ? curYear - 1 : curYear;

      // Create a past month rating for Student 1 (Mathematics: 4, 4, 4, 4 = 4.0)
      await StudentRating.create({
        student: studentUser1._id,
        subject: mathSubject._id,
        subjectName: mathSubject.name,
        class: sampleClass._id,
        teacher: teacherUser._id,
        academicYear: activeYear._id,
        month: prevMonth,
        year: prevYear,
        classEngagement: 4,
        homeworkClasswork: 4,
        behaviourSocial: 4,
        englishComm: 4,
        averageScore: 4.0,
        remarks: 'Consistent participation in geometry problems.',
      });

      // Create a current month rating for Student 1 (Science: 5, 5, 5, 5 = 5.0) -> in progress (1 of 2 subjects rated)
      await StudentRating.create({
        student: studentUser1._id,
        subject: scienceSubject._id,
        subjectName: scienceSubject.name,
        class: sampleClass._id,
        teacher: teacherUser._id,
        academicYear: activeYear._id,
        month: curMonth,
        year: curYear,
        classEngagement: 5,
        homeworkClasswork: 5,
        behaviourSocial: 5,
        englishComm: 5,
        averageScore: 5.0,
        remarks: 'Brilliant science lab report and teamwork.',
      });

      // Create ratings for Peer Student (Student 2) with average 3.0
      await StudentRating.create({
        student: studentUser2._id,
        subject: mathSubject._id,
        subjectName: mathSubject.name,
        class: sampleClass._id,
        teacher: teacherUser._id,
        academicYear: activeYear._id,
        month: prevMonth,
        year: prevYear,
        classEngagement: 3,
        homeworkClasswork: 3,
        behaviourSocial: 3,
        englishComm: 3,
        averageScore: 3.0,
      });

      const res = await request(app)
        .get('/api/student-ratings/my-ratings')
        .set('Authorization', `Bearer ${studentToken1}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify Cumulative Data
      expect(res.body.cumulativeAverage).toBe(4.5); // (4.0 + 5.0) / 2 = 4.5
      expect(res.body.cumulativeCount).toBe(2);
      expect(res.body.cumulativeEvaluation.label).toBe('Excellent');
      expect(res.body.cumulativeDataPoints.classEngagement).toBe(4.5);
      expect(res.body.cumulativeDataPoints.homeworkClasswork).toBe(4.5);

      // Verify Class Comparison
      expect(res.body.classComparison).toBeDefined();
      expect(res.body.classComparison.totalStudents).toBe(2);
      expect(res.body.classComparison.rank).toBe(1); // Student 1 (4.5) > Student 2 (3.0)
      expect(res.body.classComparison.standingLabel).toBe('Top Performer');

      // Verify Current Month Status
      expect(res.body.currentMonth).toBeDefined();
      expect(res.body.currentMonth.status).toBe('in_progress');
      expect(res.body.currentMonth.ratedCount).toBe(1);
      expect(res.body.currentMonth.totalSubjects).toBe(2);
      expect(res.body.currentMonth.provisionalAverage).toBe(5.0);

      // Verify Cumulative Subjects Breakdown (Tab 3)
      expect(Array.isArray(res.body.cumulativeSubjects)).toBe(true);
      expect(res.body.cumulativeSubjects.length).toBe(2);
      const mathSub = res.body.cumulativeSubjects.find(s => s.subjectName === 'Mathematics');
      expect(mathSub.cumulativeAverage).toBe(4.0);
      expect(mathSub.evaluatedMonthsCount).toBe(1);

      // Verify Teacher Remarks Feed (Tab 3)
      expect(Array.isArray(res.body.teacherRemarksFeed)).toBe(true);
      expect(res.body.teacherRemarksFeed.length).toBe(2);
      expect(res.body.teacherRemarksFeed[0].remarks).toBeDefined();
    });
  });

  describe('GET /api/dashboard/student ratings payload', () => {
    it('returns cumulative ratings and current month status on dashboard', async () => {
      const { month: curMonth, year: curYear } = getISTMonthYear();

      await StudentRating.create({
        student: studentUser1._id,
        subject: mathSubject._id,
        subjectName: mathSubject.name,
        class: sampleClass._id,
        teacher: teacherUser._id,
        academicYear: activeYear._id,
        month: curMonth,
        year: curYear,
        classEngagement: 4,
        homeworkClasswork: 4,
        behaviourSocial: 4,
        englishComm: 4,
        averageScore: 4.0,
      });

      const res = await request(app)
        .get('/api/dashboard/student')
        .set('Authorization', `Bearer ${studentToken1}`);

      expect(res.status).toBe(200);
      const rating = res.body.overview.rating;
      expect(rating).toBeDefined();
      expect(rating.cumulativeAverage).toBe(4.0);
      expect(rating.classComparison).toBeDefined();
      expect(rating.currentMonth).toBeDefined();
      expect(rating.currentMonth.ratedCount).toBe(1);
      expect(rating.currentMonth.totalSubjects).toBe(2);
      expect(rating.currentMonth.status).toBe('in_progress');
    });
  });
});

