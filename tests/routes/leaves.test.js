const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../index');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const AcademicYear = require('../../src/models/AcademicYear');
const LeaveRequest = require('../../src/models/LeaveRequest');

describe('Leave Management API Routes (/api/leaves)', () => {
  let teacherUser, studentUser;
  let teacherToken, studentToken;
  let academicYear, sampleClass;

  beforeEach(async () => {
    academicYear = await AcademicYear.create({
      name: '2025-2026',
      startDate: new Date('2025-06-01'),
      endDate: new Date('2026-04-30'),
      isActive: true,
    });

    teacherUser = await User.create({
      name: 'Teacher Leave',
      phone: '9888833302',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0,
      academicYear: academicYear._id,
    });

    sampleClass = await Class.create({
      name: 'Class 7',
      label: 'Class 7-A',
      value: 'class-7-a',
      section: 'A',
      academicYear: academicYear._id,
      classTeacher: teacherUser._id,
    });

    studentUser = await User.create({
      name: 'Student Leave',
      phone: '9888833303',
      password: 'password123',
      role: 'student',
      isActive: true,
      tokenVersion: 0,
      academicYear: academicYear._id,
      currentClass: sampleClass._id,
      class: sampleClass._id,
    });

    sampleClass.students = [studentUser._id];
    await sampleClass.save();

    teacherToken = jwt.sign(
      { userId: teacherUser._id, phone: teacherUser.phone, role: 'teacher', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
    studentToken = jwt.sign(
      { userId: studentUser._id, phone: studentUser.phone, role: 'student', tokenVersion: 0 },
      process.env.JWT_SECRET
    );
  });

  describe('POST /api/leaves/apply', () => {
    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).post('/api/leaves/apply').send({
        startDate: '2026-03-10',
        endDate: '2026-03-12',
        reason: 'Family event',
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 when end date is earlier than start date', async () => {
      const res = await request(app)
        .post('/api/leaves/apply')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          startDate: '2026-03-15',
          endDate: '2026-03-10',
          reason: 'Sick leave',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/End date cannot be before start date/i);
    });

    it('successfully submits a full-day leave application', async () => {
      const res = await request(app)
        .post('/api/leaves/apply')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          startDate: '2026-03-10',
          endDate: '2026-03-12',
          reason: 'Fever and cold',
          leaveType: 'full',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.applicant.toString()).toBe(studentUser._id.toString());
      expect(res.body.data.reason).toBe('Fever and cold');
    });

    it('prevents overlapping duplicate leave applications on the same dates', async () => {
      // First application
      await request(app)
        .post('/api/leaves/apply')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          startDate: '2026-03-10',
          endDate: '2026-03-12',
          reason: 'Initial leave',
          leaveType: 'full',
        });

      // Second overlapping application
      const res = await request(app)
        .post('/api/leaves/apply')
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          startDate: '2026-03-11',
          endDate: '2026-03-14',
          reason: 'Duplicate overlapping leave',
          leaveType: 'full',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already have an active/i);
    });
  });

  describe('GET /api/leaves/my-leaves', () => {
    it('returns leave requests submitted by the logged in user', async () => {
      await LeaveRequest.create({
        applicant: studentUser._id,
        applicantRole: 'student',
        class: sampleClass._id,
        academicYear: academicYear._id,
        startDate: new Date('2026-03-01'),
        endDate: new Date('2026-03-02'),
        reason: 'Dentist appointment',
        status: 'approved',
      });

      const res = await request(app)
        .get('/api/leaves/my-leaves')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].reason).toBe('Dentist appointment');
    });
  });

  describe('GET /api/leaves/requests & PUT /api/leaves/:id/action', () => {
    let pendingLeave;

    beforeEach(async () => {
      pendingLeave = await LeaveRequest.create({
        applicant: studentUser._id,
        applicantRole: 'student',
        class: sampleClass._id,
        academicYear: academicYear._id,
        startDate: new Date('2026-03-20'),
        endDate: new Date('2026-03-21'),
        reason: 'Wedding ceremony',
        status: 'pending',
      });
    });

    it('blocks student from viewing class leave requests (403)', async () => {
      const res = await request(app)
        .get('/api/leaves/requests')
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(403);
    });

    it('allows assigned class teacher to view pending student requests', async () => {
      const res = await request(app)
        .get('/api/leaves/requests')
        .set('Authorization', `Bearer ${teacherToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0]._id.toString()).toBe(pendingLeave._id.toString());
    });

    it('allows teacher to approve leave request', async () => {
      const res = await request(app)
        .put(`/api/leaves/${pendingLeave._id}/action`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ status: 'approved' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const updated = await LeaveRequest.findById(pendingLeave._id);
      expect(updated.status).toBe('approved');
      expect(updated.actionBy.toString()).toBe(teacherUser._id.toString());
    });

    it('requires rejectionReason and rejectionComments when rejecting leave', async () => {
      const res = await request(app)
        .put(`/api/leaves/${pendingLeave._id}/action`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ status: 'rejected' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Rejection reason and comments are required/i);
    });
  });

  describe('DELETE /api/leaves/:id', () => {
    it('blocks other users from cancelling a leave request (403)', async () => {
      const otherStudent = await User.create({
        name: 'Other Student',
        phone: '9888833399',
        password: 'password123',
        role: 'student',
        isActive: true,
        tokenVersion: 0,
      });
      const otherStudentToken = jwt.sign(
        { userId: otherStudent._id, role: 'student', tokenVersion: 0 },
        process.env.JWT_SECRET
      );

      const leave = await LeaveRequest.create({
        applicant: studentUser._id,
        applicantRole: 'student',
        startDate: new Date('2026-03-25'),
        endDate: new Date('2026-03-26'),
        reason: 'To be cancelled',
        status: 'pending',
      });

      const res = await request(app)
        .delete(`/api/leaves/${leave._id}`)
        .set('Authorization', `Bearer ${otherStudentToken}`);

      expect(res.status).toBe(403);
    });

    it('allows owner to cancel and delete their own leave request', async () => {
      const leave = await LeaveRequest.create({
        applicant: studentUser._id,
        applicantRole: 'student',
        startDate: new Date('2026-03-25'),
        endDate: new Date('2026-03-26'),
        reason: 'Personal errand',
        status: 'pending',
      });

      const res = await request(app)
        .delete(`/api/leaves/${leave._id}`)
        .set('Authorization', `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const deleted = await LeaveRequest.findById(leave._id);
      expect(deleted).toBeNull();
    });
  });
});

