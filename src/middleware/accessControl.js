const mongoose = require('mongoose');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const User = require('../models/User');
const FeePayment = require('../models/FeePayment');

const isAdminRole = (role) => role === 'admin' || role === 'super admin';
const isSameId = (a, b) => a && b && a.toString() === b.toString();
const hasObjectIdMatch = (ids = [], userId) => ids.some((id) => isSameId(id, userId));

const deny = (res, message = 'Not authorized') => res.status(403).json({ success: false, message });

const canAccessStudent = async (requestUser, studentId) => {
  if (!requestUser || !mongoose.Types.ObjectId.isValid(studentId)) return false;
  if (isAdminRole(requestUser.role)) return true;
  if (requestUser.role === 'student') return isSameId(requestUser.userId, studentId);
  if (requestUser.role !== 'teacher') return false;

  const student = await User.findById(studentId).select('currentClass role').lean();
  if (!student || student.role !== 'student' || !student.currentClass) return false;
  return canAccessClass(requestUser, student.currentClass);
};

const canAccessClass = async (requestUser, classId) => {
  if (!requestUser || !mongoose.Types.ObjectId.isValid(classId)) return false;
  if (isAdminRole(requestUser.role)) return true;
  if (requestUser.role !== 'teacher') return false;

  const classDoc = await Class.findById(classId).select('classTeacher').lean();
  if (!classDoc) return false;
  if (isSameId(classDoc.classTeacher, requestUser.userId)) return true;

  const subject = await Subject.findOne({ class: classId, teachers: requestUser.userId }).select('_id').lean();
  return Boolean(subject);
};

const canAccessSubject = async (requestUser, subjectId) => {
  if (!requestUser || !mongoose.Types.ObjectId.isValid(subjectId)) return false;
  if (isAdminRole(requestUser.role)) return true;
  if (requestUser.role !== 'teacher') return false;

  const subject = await Subject.findById(subjectId).select('teachers class').lean();
  if (!subject) return false;
  if (hasObjectIdMatch(subject.teachers, requestUser.userId)) return true;
  if (subject.class) return canAccessClass(requestUser, subject.class);
  return false;
};

const requireStudentAccessParam = (paramName = 'studentId') => async (req, res, next) => {
  try {
    const studentId = req.params[paramName];
    if (await canAccessStudent(req.user, studentId)) return next();
    return deny(res);
  } catch (error) {
    console.error('Student access check failed:', error);
    return res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
};

const requireClassAccessParam = (paramName = 'classId') => async (req, res, next) => {
  try {
    const classId = req.params[paramName] || req.body[paramName] || req.query[paramName];
    if (await canAccessClass(req.user, classId)) return next();
    return deny(res);
  } catch (error) {
    console.error('Class access check failed:', error);
    return res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
};

const requireFeeReceiptAccess = async (req, res, next) => {
  try {
    const payment = await FeePayment.findById(req.params.paymentId)
      .populate('student', 'name email phone')
      .populate('class', 'name section')
      .populate('academicYear', 'name startDate endDate')
      .populate('collectedBy', 'name')
      .lean();

    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    if (isAdminRole(req.user.role) || (req.user.role === 'student' && isSameId(req.user.userId, payment.student?._id || payment.student))) {
      req.payment = payment;
      return next();
    }

    return deny(res);
  } catch (error) {
    console.error('Fee receipt access check failed:', error);
    return res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
};

module.exports = {
  isAdminRole,
  isSameId,
  hasObjectIdMatch,
  canAccessStudent,
  canAccessClass,
  canAccessSubject,
  requireStudentAccessParam,
  requireClassAccessParam,
  requireFeeReceiptAccess
};
