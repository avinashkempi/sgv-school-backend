const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../../src/models/User');
const Class = require('../../src/models/Class');
const AcademicYear = require('../../src/models/AcademicYear');
const Subject = require('../../src/models/Subject');
const {
  authenticateToken,
  requireAdmin,
  checkRole,
  requireFinanceAccess,
  invalidateUserCache
} = require('../../src/middleware/auth');
const {
  canAccessStudent,
  canAccessClass
} = require('../../src/middleware/accessControl');
const errorHandler = require('../../src/middleware/errorHandler');

describe('Backend Middleware & Security', () => {
  let studentUser;
  let teacherUser;
  let adminUser;
  let testClass;

  beforeEach(async () => {
    invalidateUserCache();

    const academicYear = await AcademicYear.create({
      name: '2026-2027',
      startDate: new Date('2026-06-01'),
      endDate: new Date('2027-04-30'),
      isActive: true,
      status: 'current'
    });

    testClass = await Class.create({
      name: 'Class 10A',
      value: '10',
      label: 'Class 10A',
      section: 'A',
      branch: 'Main',
      academicYear: academicYear._id
    });

    studentUser = await User.create({
      name: 'Test Student',
      phone: '9876543210',
      password: 'password123',
      role: 'student',
      currentClass: testClass._id,
      isActive: true,
      tokenVersion: 0
    });

    teacherUser = await User.create({
      name: 'Test Teacher',
      phone: '9876543211',
      password: 'password123',
      role: 'teacher',
      isActive: true,
      tokenVersion: 0
    });

    adminUser = await User.create({
      name: 'Test Admin',
      phone: '9876543212',
      password: 'password123',
      role: 'admin',
      isActive: true,
      tokenVersion: 0
    });
  });

  describe('auth.js (authenticateToken)', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const req = { headers: {} };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await authenticateToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringMatching(/Access token required/i)
      }));
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when token is malformed', async () => {
      const req = { headers: { authorization: 'Bearer invalid.token.value' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await authenticateToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('authenticates valid token and populates req.user', async () => {
      const token = jwt.sign(
        { userId: studentUser._id, role: studentUser.role, tokenVersion: studentUser.tokenVersion },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );

      const req = { headers: { authorization: `Bearer ${token}` } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await authenticateToken(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.name).toBe('Test Student');
      expect(req.user.role).toBe('student');
    });

    it('rejects deactivated/inactive user', async () => {
      studentUser.isActive = false;
      await studentUser.save();

      const token = jwt.sign(
        { userId: studentUser._id, role: studentUser.role, tokenVersion: studentUser.tokenVersion },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );

      const req = { headers: { authorization: `Bearer ${token}` } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      const next = jest.fn();

      await authenticateToken(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Role-based guards', () => {
    describe('requireAdmin', () => {
      it('allows admin and super admin users', () => {
        const reqAdmin = { user: { role: 'admin' } };
        const reqSuper = { user: { role: 'super admin' } };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        requireAdmin(reqAdmin, res, next);
        expect(next).toHaveBeenCalledTimes(1);

        requireAdmin(reqSuper, res, next);
        expect(next).toHaveBeenCalledTimes(2);
      });

      it('blocks teachers and students with 403', () => {
        const reqTeacher = { user: { role: 'teacher' } };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        requireAdmin(reqTeacher, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });
    });

    describe('checkRole', () => {
      it('allows allowed roles and rejects others', () => {
        const guard = checkRole(['teacher', 'admin']);
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        guard({ user: { role: 'teacher' } }, res, next);
        expect(next).toHaveBeenCalled();

        guard({ user: { role: 'student' } }, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
      });
    });

    describe('requireFinanceAccess', () => {
      it('blocks teachers from accessing fee records', () => {
        const req = { user: { role: 'teacher' } };
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        requireFinanceAccess(req, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
      });

      it('allows admin and student', () => {
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        const next = jest.fn();

        requireFinanceAccess({ user: { role: 'admin' } }, res, next);
        expect(next).toHaveBeenCalledTimes(1);

        requireFinanceAccess({ user: { role: 'student' } }, res, next);
        expect(next).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('accessControl.js helper permissions', () => {
    it('admin has access to any student and any class', async () => {
      const adminReqUser = { role: 'admin', userId: adminUser._id };
      expect(await canAccessStudent(adminReqUser, studentUser._id)).toBe(true);
      expect(await canAccessClass(adminReqUser, testClass._id)).toBe(true);
    });

    it('student can only access their own student profile', async () => {
      const studentReqUser = { role: 'student', userId: studentUser._id };
      expect(await canAccessStudent(studentReqUser, studentUser._id)).toBe(true);

      const otherStudentId = new mongoose.Types.ObjectId();
      expect(await canAccessStudent(studentReqUser, otherStudentId)).toBe(false);
    });

    it('teacher can access class if assigned as classTeacher', async () => {
      const teacherReqUser = { role: 'teacher', userId: teacherUser._id };
      
      // Before assignment
      expect(await canAccessClass(teacherReqUser, testClass._id)).toBe(false);

      // Assign teacher as classTeacher
      testClass.classTeacher = teacherUser._id;
      await testClass.save();

      expect(await canAccessClass(teacherReqUser, testClass._id)).toBe(true);
      expect(await canAccessStudent(teacherReqUser, studentUser._id)).toBe(true);
    });
  });

  describe('errorHandler.js', () => {
    it('formats Mongoose ValidationError with 400 and field details', () => {
      const validationErr = {
        name: 'ValidationError',
        errors: {
          name: { path: 'name', message: 'Name is required' }
        }
      };
      const req = { id: 'req-123', method: 'POST', url: '/api/users' };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      errorHandler(validationErr, req, res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: 'Validation Error',
        errors: [{ field: 'name', message: 'Name is required' }]
      }));
    });

    it('handles MongoDB duplicate key error code 11000 with 409', () => {
      const dupErr = { code: 11000, keyPattern: { phone: 1 } };
      const req = { id: 'req-123', method: 'POST', url: '/api/users' };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      errorHandler(dupErr, req, res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        message: expect.stringMatching(/Duplicate entry for: phone/)
      }));
    });
  });
});
