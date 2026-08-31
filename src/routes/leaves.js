const express = require('express');
const router = express.Router();
const LeaveRequest = require('../models/LeaveRequest');
const User = require('../models/User');
const Class = require('../models/Class');
const Attendance = require('../models/Attendance');
const AcademicYear = require('../models/AcademicYear');
const Event = require('../models/Event');
const { authenticateToken, checkRole } = require('../middleware/auth');
const notificationController = require('../controllers/notificationController');
const toTitleCase = require('../utils/titleCase');
const {
    isISTSunday,
    getISTDayBounds,
    getISTDateObject,
    getISTDateString,
    getISTToday
} = require('../utils/dateUtils');

/**
 * Helper to check for overlapping active (pending/approved) leaves in IST
 * @param {string|mongoose.Types.ObjectId} applicantId
 * @param {Date} startNormalized - normalized start date (UTC midnight representing IST date)
 * @param {Date} endNormalized - normalized end date (UTC midnight representing IST date)
 * @param {string} leaveType - 'full' | 'half'
 * @param {string} halfDaySlot - 'morning' | 'afternoon'
 * @param {string|mongoose.Types.ObjectId} [excludeLeaveId] - Optional leave ID to exclude (for editing)
 * @returns {Promise<{ hasConflict: boolean, conflictingLeave?: object, message?: string }>}
 */
async function checkLeaveOverlap(applicantId, startNormalized, endNormalized, leaveType, halfDaySlot, excludeLeaveId = null) {
    const query = {
        applicant: applicantId,
        status: { $in: ['pending', 'approved'] },
        startDate: { $lte: endNormalized },
        endDate: { $gte: startNormalized }
    };

    if (excludeLeaveId) {
        query._id = { $ne: excludeLeaveId };
    }

    const overlappingLeaves = await LeaveRequest.find(query).lean();

    for (const ex of overlappingLeaves) {
        // If either the new leave or existing leave is 'full' day, they conflict across the overlapping dates
        if (leaveType === 'full' || ex.leaveType === 'full') {
            const startStr = getISTDateString(ex.startDate);
            const endStr = getISTDateString(ex.endDate);
            const rangeStr = startStr === endStr ? startStr : `${startStr} to ${endStr}`;
            return {
                hasConflict: true,
                conflictingLeave: ex,
                message: `You already have an active (${ex.status}) leave request for ${rangeStr}. You cannot apply for duplicate leaves on the same day. Please edit your existing leave request instead.`
            };
        }

        // Both are 'half' day leaves
        if (leaveType === 'half' && ex.leaveType === 'half') {
            const newStartStr = getISTDateString(startNormalized);
            const exStartStr = getISTDateString(ex.startDate);
            // If on the same date and same slot (or if slot is undefined)
            if (newStartStr === exStartStr) {
                if (!halfDaySlot || !ex.halfDaySlot || halfDaySlot === ex.halfDaySlot) {
                    return {
                        hasConflict: true,
                        conflictingLeave: ex,
                        message: `You already have an active (${ex.status}) half-day (${ex.halfDaySlot || 'slot'}) leave request for ${newStartStr}. Please edit your existing leave request instead.`
                    };
                }
            }
        }
    }

    return { hasConflict: false };
}

/**
 * Helper to send notifications when leave is applied or edited
 */
async function sendLeaveAppliedNotification(leaveRequest, user, start, end, isEdit = false) {
    try {
        const applicantName = toTitleCase(user.name);
        const startDateStr = getISTDateString(start);
        const endDateStr = getISTDateString(end);
        const dateRangeStr = startDateStr === endDateStr ? startDateStr : `${startDateStr} to ${endDateStr}`;
        const prefix = isEdit ? '✏️ Leave Request Updated' : '📋 New Leave Request';
        const actionVerb = isEdit ? 'updated their leave request for' : 'requested leave for';

        if (user.role === 'student') {
            // Student leave: notify the class teacher of the student's class
            const classObj = await Class.findById(leaveRequest.class).select('classTeacher').lean();
            if (classObj?.classTeacher) {
                notificationController.triggerNotification({
                    title: prefix,
                    message: `${applicantName} has ${actionVerb} ${dateRangeStr}. Please review and respond.`,
                    type: 'General',
                    category: 'leave',
                    priority: 'high',
                    target: 'user',
                    targetId: classObj.classTeacher,
                    metadata: { leaveId: leaveRequest._id }
                });
            } else {
                // Fallback: If no class teacher is assigned to this class, notify all Admins
                notificationController.triggerNotification({
                    title: prefix,
                    message: `${applicantName} (Student) has ${actionVerb} ${dateRangeStr}. Awaiting your approval.`,
                    type: 'General',
                    category: 'leave',
                    priority: 'high',
                    target: 'admin',
                    metadata: { leaveId: leaveRequest._id }
                });
            }
        } else if (['teacher', 'staff', 'support_staff'].includes(user.role)) {
            // Teacher/Staff leave: notify all admins
            const roleLabel = user.role === 'support_staff' ? 'Support Staff' : user.role === 'staff' ? 'Staff' : 'Teacher';
            notificationController.triggerNotification({
                title: prefix,
                message: `${applicantName} (${roleLabel}) has ${actionVerb} ${dateRangeStr}. Awaiting your approval.`,
                type: 'General',
                category: 'leave',
                priority: 'high',
                target: 'admin',
                metadata: { leaveId: leaveRequest._id }
            });
        } else if (['admin', 'super admin'].includes(user.role)) {
            // Admin leave: notify all super admins
            notificationController.triggerNotification({
                title: prefix,
                message: `${applicantName} (Admin) has ${actionVerb} ${dateRangeStr}. Awaiting your approval.`,
                type: 'General',
                category: 'leave',
                priority: 'high',
                target: 'super admin',
                metadata: { leaveId: leaveRequest._id }
            });
        }
    } catch (notifErr) {
        console.error('[Leave Apply Notification] Error:', notifErr);
    }
}

// @desc    Apply for leave
// @route   POST /api/leaves/apply
// @access  Private (All)
router.post('/apply', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate, reason, leaveType, halfDaySlot } = req.body;

        // Validate required fields
        if (!startDate || !endDate || !reason || !reason.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: startDate, endDate, and reason are required'
            });
        }

        const isHalf = leaveType === 'half';
        const start = getISTDateObject(startDate);
        const end = isHalf ? getISTDateObject(startDate) : getISTDateObject(endDate);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid date format. Please use YYYY-MM-DD format'
            });
        }

        if (end < start) {
            return res.status(400).json({
                success: false,
                message: 'End date cannot be before start date'
            });
        }

        if (isHalf && !['morning', 'afternoon'].includes(halfDaySlot)) {
            return res.status(400).json({
                success: false,
                message: 'Half-day slot must be either morning or afternoon'
            });
        }

        // Duplicate / Overlap Validation
        const overlapResult = await checkLeaveOverlap(req.user.userId, start, end, leaveType || 'full', halfDaySlot);
        if (overlapResult.hasConflict) {
            return res.status(400).json({
                success: false,
                message: overlapResult.message
            });
        }

        const user = await User.findById(req.user.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        let classId = undefined;
        let academicYearId = undefined;

        if (req.user.role === 'student') {
            if (!user.currentClass) {
                return res.status(400).json({ success: false, message: 'Student is not assigned to any class' });
            }
            classId = user.currentClass;
            const studentClass = await Class.findById(classId).select('academicYear classTeacher').lean();
            if (studentClass?.academicYear) {
                academicYearId = studentClass.academicYear;
            }
        }

        // If academicYear is not resolved yet, find active or matching academic year
        if (!academicYearId) {
            let matchedYear = await AcademicYear.findOne({
                startDate: { $lte: start },
                endDate: { $gte: start }
            }).select('_id').lean();

            if (!matchedYear) {
                matchedYear = await AcademicYear.findOne({ isActive: true }).select('_id').lean();
            }
            if (matchedYear) {
                academicYearId = matchedYear._id;
            }
        }

        const leaveRequest = await LeaveRequest.create({
            applicant: req.user.userId,
            applicantRole: req.user.role,
            class: classId,
            academicYear: academicYearId,
            startDate: start,
            endDate: end,
            reason: reason.trim(),
            leaveType: isHalf ? 'half' : 'full',
            halfDaySlot: isHalf ? halfDaySlot : undefined
        });

        res.status(201).json({
            success: true,
            data: leaveRequest,
            message: 'Leave request submitted successfully'
        });

        // Trigger Notification
        await sendLeaveAppliedNotification(leaveRequest, user, start, end, false);
    } catch (error) {
        console.error('[Leave Apply] Error:', error);
        res.status(500).json({ success: false, message: 'Server Error', error: error.message });
    }
});

// @desc    Edit leave application (Applicant or Admin)
// @route   PUT /api/leaves/:id
// @access  Private (Applicant, Admin, Super Admin)
router.put('/:id', authenticateToken, async (req, res) => {
    try {
        if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ success: false, message: 'Invalid leave request ID format' });
        }

        const leaveRequest = await LeaveRequest.findById(req.params.id);
        if (!leaveRequest) {
            return res.status(404).json({ success: false, message: 'Leave request not found' });
        }

        const isOwner = leaveRequest.applicant.toString() === req.user.userId.toString();
        const isAdmin = ['admin', 'super admin'].includes(req.user.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ success: false, message: 'Not authorized to edit this leave request' });
        }

        // Only pending leave requests can be edited
        if (leaveRequest.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Only pending leave requests can be edited. This leave request has already been ${leaveRequest.status}.`
            });
        }

        const { startDate, endDate, reason, leaveType, halfDaySlot } = req.body;

        if (!startDate || !endDate || !reason || !reason.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: startDate, endDate, and reason are required'
            });
        }

        const isHalf = leaveType === 'half';
        const start = getISTDateObject(startDate);
        const end = isHalf ? getISTDateObject(startDate) : getISTDateObject(endDate);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid date format. Please use YYYY-MM-DD format'
            });
        }

        if (end < start) {
            return res.status(400).json({
                success: false,
                message: 'End date cannot be before start date'
            });
        }

        if (isHalf && !['morning', 'afternoon'].includes(halfDaySlot)) {
            return res.status(400).json({
                success: false,
                message: 'Half-day slot must be either morning or afternoon'
            });
        }

        // Overlap Check (Excluding this current leave ID)
        const overlapResult = await checkLeaveOverlap(
            leaveRequest.applicant,
            start,
            end,
            leaveType || 'full',
            halfDaySlot,
            leaveRequest._id
        );

        if (overlapResult.hasConflict) {
            return res.status(400).json({
                success: false,
                message: overlapResult.message
            });
        }

        leaveRequest.startDate = start;
        leaveRequest.endDate = end;
        leaveRequest.reason = reason.trim();
        leaveRequest.leaveType = isHalf ? 'half' : 'full';
        leaveRequest.halfDaySlot = isHalf ? halfDaySlot : undefined;

        await leaveRequest.save();

        res.status(200).json({
            success: true,
            data: leaveRequest,
            message: 'Leave request updated successfully'
        });

        // Trigger Notification about update
        const user = await User.findById(leaveRequest.applicant).select('name role').lean();
        if (user) {
            await sendLeaveAppliedNotification(leaveRequest, user, start, end, true);
        }
    } catch (error) {
        console.error('[Leave Edit] Error:', error);
        res.status(500).json({ success: false, message: 'Server Error', error: error.message });
    }
});

// @desc    Cancel / Delete leave application (Applicant or Admin)
// @route   DELETE /api/leaves/:id
// @access  Private (Applicant, Admin, Super Admin)
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ success: false, message: 'Invalid leave request ID format' });
        }

        const leaveRequest = await LeaveRequest.findById(req.params.id);
        if (!leaveRequest) {
            return res.status(404).json({ success: false, message: 'Leave request not found' });
        }

        const isOwner = leaveRequest.applicant.toString() === req.user.userId.toString();
        const isAdmin = ['admin', 'super admin'].includes(req.user.role);

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ success: false, message: 'Not authorized to cancel this leave request' });
        }

        const previousStatus = leaveRequest.status;

        // If approved, cleanly revert any marked attendance records in IST
        if (previousStatus === 'approved') {
            const startDate = new Date(leaveRequest.startDate);
            const endDate = new Date(leaveRequest.endDate);
            const activeYear = await AcademicYear.findOne({ isActive: true });

            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dateToMark = getISTDateObject(d);
                const deleteFilter = {
                    user: leaveRequest.applicant,
                    date: dateToMark,
                    remarks: 'On Leave (Approved)'
                };
                if (activeYear) deleteFilter.academicYear = activeYear._id;
                await Attendance.deleteOne(deleteFilter);
            }
        }

        await LeaveRequest.findByIdAndDelete(req.params.id);

        res.status(200).json({
            success: true,
            message: 'Leave request cancelled and removed successfully'
        });
    } catch (error) {
        console.error('[Leave Delete] Error:', error);
        res.status(500).json({ success: false, message: 'Server Error', error: error.message });
    }
});

// @desc    Get my leave history
// @route   GET /api/leaves/my-leaves
// @access  Private (All)
router.get('/my-leaves', authenticateToken, async (req, res) => {
    try {
        const { academicYear, status } = req.query;
        let query = { applicant: req.user.userId };

        if (status && status !== 'all') {
            query.status = status;
        }

        if (academicYear && academicYear !== 'all') {
            const classesInYear = await Class.find({ academicYear }).select('_id').lean();
            const classIdsInYear = classesInYear.map(c => c._id);
            const activeYearDoc = await AcademicYear.findOne({ isActive: true }).select('_id').lean();
            const isActiveYear = activeYearDoc && activeYearDoc._id.toString() === academicYear.toString();

            const yearOr = [{ academicYear: academicYear }];
            if (classIdsInYear.length > 0) {
                yearOr.push({ class: { $in: classIdsInYear } });
            }
            if (isActiveYear) {
                yearOr.push({ academicYear: { $exists: false } }, { academicYear: null });
            }
            query.$or = yearOr;
        }

        let leaves = await LeaveRequest.find(query)
            .populate('class', 'name label section branch academicYear')
            .populate('academicYear', 'name isActive startDate endDate status')
            .populate('actionBy', 'name role profilePhoto')
            .sort({ createdAt: -1 })
            .lean();

        const activeYear = await AcademicYear.findOne({ isActive: true }).select('name isActive status').lean();
        leaves = leaves.map(leave => {
            if (!leave.academicYear) {
                if (leave.class?.academicYear) {
                    leave.academicYear = leave.class.academicYear;
                } else if (activeYear) {
                    leave.academicYear = activeYear;
                }
            }
            return leave;
        });

        res.status(200).json({ success: true, data: leaves });
    } catch (error) {
        console.error('[My Leaves] Error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// Handler helper for getting leave requests
const getLeaveRequestsHandler = async (req, res) => {
    try {
        const { status, academicYear, classId, role, search } = req.query;
        let andConditions = [];

        if (status && status !== 'all') {
            andConditions.push({ status });
        }

        if (classId && classId !== 'all') {
            andConditions.push({ class: classId });
        }

        if (academicYear && academicYear !== 'all') {
            const classesInYear = await Class.find({ academicYear }).select('_id').lean();
            const classIdsInYear = classesInYear.map(c => c._id);
            const activeYearDoc = await AcademicYear.findOne({ isActive: true }).select('_id').lean();
            const isActiveYear = activeYearDoc && activeYearDoc._id.toString() === academicYear.toString();

            const yearOr = [{ academicYear: academicYear }];
            if (classIdsInYear.length > 0) {
                yearOr.push({ class: { $in: classIdsInYear } });
            }
            if (isActiveYear) {
                yearOr.push({ academicYear: { $exists: false } }, { academicYear: null });
            }
            andConditions.push({ $or: yearOr });
        }

        if (req.user.role === 'teacher') {
            // Teacher sees leaves for students in their assigned class(es)
            const teacherClasses = await Class.find({ classTeacher: req.user.userId }).select('_id');
            if (!teacherClasses || teacherClasses.length === 0) {
                return res.status(200).json({ success: true, data: [] }); // No class assigned
            }
            const classIds = teacherClasses.map(c => c._id);
            
            if (classId && classId !== 'all') {
                const isAssigned = classIds.some(id => id.toString() === classId.toString());
                if (!isAssigned) {
                    return res.status(200).json({ success: true, data: [] });
                }
                andConditions.push({ class: classId });
            } else {
                andConditions.push({ class: { $in: classIds } });
            }
            andConditions.push({ applicantRole: 'student' });
        } else if (req.user.role === 'admin') {
            // Admin sees leaves for Students (All), Teachers, and Staff
            const allowedAdminRoles = ['student', 'teacher', 'staff', 'support_staff'];
            if (role && role !== 'all') {
                if (role === 'staff_teachers') {
                    andConditions.push({ applicantRole: { $in: ['teacher', 'staff', 'support_staff'] } });
                } else if (role === 'staff') {
                    andConditions.push({ applicantRole: { $in: ['staff', 'support_staff'] } });
                } else if (allowedAdminRoles.includes(role)) {
                    andConditions.push({ applicantRole: role });
                } else {
                    andConditions.push({ applicantRole: { $in: allowedAdminRoles } });
                }
            } else {
                andConditions.push({ applicantRole: { $in: allowedAdminRoles } });
            }
        } else if (req.user.role === 'super admin') {
            // Super Admin sees ALL leaves (including Admins)
            const allowedSuperRoles = ['student', 'teacher', 'staff', 'support_staff', 'admin'];
            if (role && role !== 'all') {
                if (role === 'staff_teachers') {
                    andConditions.push({ applicantRole: { $in: ['teacher', 'staff', 'support_staff'] } });
                } else if (role === 'staff') {
                    andConditions.push({ applicantRole: { $in: ['staff', 'support_staff'] } });
                } else if (allowedSuperRoles.includes(role)) {
                    andConditions.push({ applicantRole: role });
                } else {
                    andConditions.push({ applicantRole: { $in: allowedSuperRoles } });
                }
            } else {
                andConditions.push({ applicantRole: { $in: allowedSuperRoles } });
            }
        }

        // Search text support
        if (search && search.trim()) {
            const cleanSearch = search.trim();
            const matchingUsers = await User.find({
                name: { $regex: cleanSearch, $options: 'i' }
            }).select('_id').lean();

            const userIds = matchingUsers.map(u => u._id);
            andConditions.push({
                $or: [
                    { applicant: { $in: userIds } },
                    { reason: { $regex: cleanSearch, $options: 'i' } }
                ]
            });
        }

        const query = andConditions.length > 0 ? { $and: andConditions } : {};

        let leaves = await LeaveRequest.find(query)
            .populate('applicant', 'name role profilePhoto email phone currentClass designation')
            .populate({
                path: 'class',
                select: 'name label value section branch academicYear',
                populate: { path: 'academicYear', select: 'name isActive' }
            })
            .populate('academicYear', 'name isActive startDate endDate status')
            .populate('actionBy', 'name role profilePhoto')
            .sort({ createdAt: -1 })
            .lean();

        // Fallback for legacy documents missing academicYear reference
        const activeYear = await AcademicYear.findOne({ isActive: true }).select('name isActive status').lean();
        leaves = leaves.map(leave => {
            if (!leave.academicYear) {
                if (leave.class?.academicYear) {
                    leave.academicYear = leave.class.academicYear;
                } else if (activeYear) {
                    leave.academicYear = activeYear;
                }
            }
            return leave;
        });

        res.status(200).json({ success: true, data: leaves });
    } catch (error) {
        console.error('[Leave Requests] Error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Get leave requests (Role based) with filters
// @route   GET /api/leaves/requests
// @access  Private (Teacher, Admin, Super Admin)
router.get('/requests', authenticateToken, checkRole(['teacher', 'admin', 'super admin']), getLeaveRequestsHandler);

// @desc    Get pending leave requests (Alias for GET /requests?status=pending)
// @route   GET /api/leaves/pending
// @access  Private (Teacher, Admin, Super Admin)
router.get('/pending', authenticateToken, checkRole(['teacher', 'admin', 'super admin']), (req, res) => {
    req.query.status = req.query.status || 'pending';
    return getLeaveRequestsHandler(req, res);
});

// @desc    Approve/Reject leave request
// @route   PUT /api/leaves/:id/action
// @access  Private (Teacher, Admin, Super Admin)
router.put('/:id/action', authenticateToken, checkRole(['teacher', 'admin', 'super admin']), async (req, res) => {
    try {
        const { status, reason, rejectionReason, rejectionComments } = req.body; // status: 'approved' or 'rejected'

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        if (status === 'rejected' && (!rejectionReason || !rejectionComments)) {
            return res.status(400).json({ success: false, message: 'Rejection reason and comments are required' });
        }

        // Validate ObjectId format
        if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ success: false, message: 'Invalid leave request ID format' });
        }

        let leaveRequest = await LeaveRequest.findById(req.params.id).populate('applicant');

        if (!leaveRequest) {
            return res.status(404).json({ success: false, message: 'Leave request not found' });
        }

        const previousStatus = leaveRequest.status;

        // Authorization Check (Any One Approves logic)
        let isAuthorized = false;
        const applicantRole = leaveRequest.applicantRole;

        if (applicantRole === 'student') {
            // Student leave: Teacher of that class OR Admin OR Super Admin can approve
            if (req.user.role === 'teacher') {
                if (leaveRequest.class) {
                    const isTeacherOfClass = await Class.exists({
                        _id: leaveRequest.class,
                        classTeacher: req.user.userId
                    });
                    if (isTeacherOfClass) {
                        isAuthorized = true;
                    }
                }
            } else if (['admin', 'super admin'].includes(req.user.role)) {
                isAuthorized = true;
            }
        } else if (['teacher', 'staff', 'support_staff'].includes(applicantRole)) {
            // Teacher/Staff leave: Admin OR Super Admin can approve
            if (['admin', 'super admin'].includes(req.user.role)) {
                isAuthorized = true;
            }
        } else if (applicantRole === 'admin') {
            // Admin leave: Super Admin can approve
            if (req.user.role === 'super admin') {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({ success: false, message: 'Not authorized to manage this leave request' });
        }

        leaveRequest.status = status;
        leaveRequest.actionBy = req.user.userId;
        leaveRequest.actionReason = reason; // Generic note
        if (status === 'rejected') {
            leaveRequest.rejectionReason = rejectionReason;
            leaveRequest.rejectionComments = rejectionComments;
        } else {
            // Clear rejection fields if approved
            leaveRequest.rejectionReason = undefined;
            leaveRequest.rejectionComments = undefined;
        }
        leaveRequest.actionDate = Date.now();

        await leaveRequest.save();

        const startDate = new Date(leaveRequest.startDate);
        const endDate = new Date(leaveRequest.endDate);

        const activeYear = await AcademicYear.findOne({ isActive: true });

        // Auto-mark attendance as absent if approved in IST
        if (status === 'approved' && previousStatus !== 'approved') {
            if (!activeYear) {
                console.error('No active academic year found for leave attendance marking');
            } else {
                // Loop through dates
                for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                    // Skip Sundays in IST
                    if (isISTSunday(d)) continue;

                    // Skip declared school holidays
                    const { startOfDay, endOfDay } = getISTDayBounds(d);
                    const isHoliday = await Event.exists({
                        isHoliday: true,
                        date: { $gte: startOfDay, $lte: endOfDay }
                    });
                    if (isHoliday) continue;

                    const dateToMark = getISTDateObject(d);

                    const filter = {
                        user: leaveRequest.applicant._id,
                        date: dateToMark,
                        academicYear: activeYear._id
                    };

                    // For students, also filter by class
                    if (leaveRequest.class) {
                        filter.class = leaveRequest.class;
                    }

                    const existingAttendance = await Attendance.findOne(filter);

                    if (existingAttendance) {
                        existingAttendance.status = 'absent';
                        existingAttendance.remarks = 'On Leave (Approved)';
                        existingAttendance.markedBy = req.user.userId;
                        await existingAttendance.save();
                    } else {
                        await Attendance.create({
                            user: leaveRequest.applicant._id,
                            role: leaveRequest.applicantRole,
                            class: leaveRequest.class || undefined,
                            date: dateToMark,
                            status: 'absent',
                            markedBy: req.user.userId,
                            remarks: 'On Leave (Approved)',
                            academicYear: activeYear._id
                        });
                    }
                }
            }
        } else if (status === 'rejected' && previousStatus === 'approved') {
            // Revert attendance (Delete the attendance record marked as Leave Approved in IST)
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dateToMark = getISTDateObject(d);

                const deleteFilter = {
                    user: leaveRequest.applicant._id,
                    date: dateToMark,
                    remarks: 'On Leave (Approved)'
                };
                if (activeYear) deleteFilter.academicYear = activeYear._id;

                await Attendance.deleteOne(deleteFilter);
            }
        }

        res.status(200).json({ success: true, data: leaveRequest });

        // Trigger Notification for applicant
        const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
        const statusEmoji = status === 'approved' ? '✅' : status === 'rejected' ? '❌' : '📋';
        const leaveDateStr = getISTDateString(leaveRequest.startDate);
        notificationController.triggerNotification({
            title: `${statusEmoji} Leave Request ${statusLabel}`,
            message: `Your leave request for ${leaveDateStr} has been ${status}. ${status === 'approved' ? 'Enjoy your time off!' : 'Please contact your teacher for more details.'}`,
            type: 'General',
            category: 'leave',
            priority: 'high',
            target: 'user',
            targetId: leaveRequest.applicant._id,
            metadata: { leaveId: leaveRequest._id }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// @desc    Get daily leave stats (Who is on leave today in IST)
// @route   GET /api/leaves/daily-stats
// @access  Private (Admin, Super Admin)
router.get('/daily-stats', authenticateToken, checkRole(['admin', 'super admin']), async (req, res) => {
    try {
        const dateStr = req.query.date; // YYYY-MM-DD in IST
        const { academicYear } = req.query;
        const { startOfDay, endOfDay } = getISTDayBounds(dateStr || new Date());

        let query = {
            startDate: { $lte: endOfDay },
            endDate: { $gte: startOfDay },
            status: 'approved'
        };

        if (academicYear && academicYear !== 'all') {
            query.academicYear = academicYear;
        }

        // Find approved leaves that overlap with targetDate in IST
        let leaves = await LeaveRequest.find(query)
            .populate('applicant', 'name role profilePhoto email phone currentClass designation')
            .populate({
                path: 'class',
                select: 'name label value section branch academicYear',
                populate: { path: 'academicYear', select: 'name isActive' }
            })
            .populate('academicYear', 'name isActive status')
            .sort({ createdAt: -1 })
            .lean();

        // Fallback for legacy documents missing academicYear reference
        const activeYear = await AcademicYear.findOne({ isActive: true }).select('name isActive status').lean();
        leaves = leaves.map(leave => {
            if (!leave.academicYear) {
                if (leave.class?.academicYear) {
                    leave.academicYear = leave.class.academicYear;
                } else if (activeYear) {
                    leave.academicYear = activeYear;
                }
            }
            return leave;
        });

        res.status(200).json({ success: true, data: leaves });
    } catch (error) {
        console.error('[Daily Stats] Error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// @desc    Get leave balance (IST & Academic Year aware)
// @route   GET /api/leaves/balance
// @access  Private (Teacher, Admin, Super Admin)
router.get('/balance', authenticateToken, async (req, res) => {
    try {
        const TOTAL_ALLOWED = 12;

        // Determine date range: Active Academic Year or current calendar year in IST
        const activeYearDoc = await AcademicYear.findOne({ isActive: true }).lean();
        let startBound, endBound;

        if (activeYearDoc && activeYearDoc.startDate && activeYearDoc.endDate) {
            startBound = getISTDateObject(activeYearDoc.startDate);
            endBound = getISTDateObject(activeYearDoc.endDate);
        } else {
            const todayISTStr = getISTToday();
            const yearStr = todayISTStr.split('-')[0];
            startBound = getISTDateObject(`${yearStr}-01-01`);
            endBound = getISTDateObject(`${yearStr}-12-31`);
        }

        const approvedLeaves = await LeaveRequest.find({
            applicant: req.user.userId,
            status: 'approved',
            startDate: { $lte: endBound },
            endDate: { $gte: startBound }
        }).lean();

        let usedDays = 0;
        approvedLeaves.forEach(leave => {
            if (leave.leaveType === 'half') {
                usedDays += 0.5;
            } else {
                // Calculate days difference clamped to boundary
                const s = new Date(Math.max(new Date(leave.startDate).getTime(), startBound.getTime()));
                const e = new Date(Math.min(new Date(leave.endDate).getTime(), endBound.getTime()));
                const diffTime = Math.abs(e - s);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
                usedDays += diffDays;
            }
        });

        res.status(200).json({
            success: true,
            data: {
                total: TOTAL_ALLOWED,
                used: usedDays,
                remaining: Math.max(0, TOTAL_ALLOWED - usedDays)
            }
        });
    } catch (error) {
        console.error('[Leave Balance] Error:', error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

module.exports = router;
