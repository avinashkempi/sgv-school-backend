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
const { isISTSunday, getISTDayBounds, getISTDateObject } = require('../utils/dateUtils');

// @desc    Apply for leave
// @desc    Apply for leave
// @route   POST /api/leaves/apply
// @access  Private (All)
router.post('/apply', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate, reason, leaveType, halfDaySlot } = req.body;

        // Validate required fields
        if (!startDate || !endDate || !reason) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: startDate, endDate, and reason are required'
            });
        }

        // Validate dates
        const start = new Date(startDate);
        const end = new Date(endDate);

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
            reason,
            leaveType: leaveType || 'full',
            halfDaySlot: leaveType === 'half' ? halfDaySlot : undefined
        });

        res.status(201).json({ success: true, data: leaveRequest });

        // Trigger Notification — send only to the concerned approver(s)
        try {
            const applicantName = toTitleCase(user.name);
            if (req.user.role === 'student') {
                // Student leave: notify the class teacher of the student's class
                const classObj = await Class.findById(classId).select('classTeacher').lean();
                if (classObj?.classTeacher) {
                    notificationController.triggerNotification({
                        title: '📋 New Leave Request',
                        message: `${applicantName} has requested leave from ${startDate} to ${endDate}. Please review and respond.`,
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
                        title: '📋 New Leave Request',
                        message: `${applicantName} (Student) has requested leave from ${startDate} to ${endDate}. Awaiting your approval.`,
                        type: 'General',
                        category: 'leave',
                        priority: 'high',
                        target: 'admin',
                        metadata: { leaveId: leaveRequest._id }
                    });
                }
            } else if (['teacher', 'staff', 'support_staff'].includes(req.user.role)) {
                // Teacher/Staff leave: notify all admins
                const roleLabel = req.user.role === 'support_staff' ? 'Support Staff' : req.user.role === 'staff' ? 'Staff' : 'Teacher';
                notificationController.triggerNotification({
                    title: '📋 New Leave Request',
                    message: `${applicantName} (${roleLabel}) has requested leave from ${startDate} to ${endDate}. Awaiting your approval.`,
                    type: 'General',
                    category: 'leave',
                    priority: 'high',
                    target: 'admin',
                    metadata: { leaveId: leaveRequest._id }
                });
            } else if (['admin', 'super admin'].includes(req.user.role)) {
                // Admin leave: notify all super admins
                notificationController.triggerNotification({
                    title: '📋 New Leave Request',
                    message: `${applicantName} (Admin) has requested leave from ${startDate} to ${endDate}. Awaiting your approval.`,
                    type: 'General',
                    category: 'leave',
                    priority: 'high',
                    target: 'super admin',
                    metadata: { leaveId: leaveRequest._id }
                });
            }
        } catch (notifErr) {
            console.error('[Leave Apply] Notification error:', notifErr);
        }
    } catch (error) {
        console.error('[Leave Apply] Error:', error);
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
            query.academicYear = academicYear;
        }

        const leaves = await LeaveRequest.find(query)
            .populate('class', 'name label section branch')
            .populate('academicYear', 'name isActive startDate endDate status')
            .populate('actionBy', 'name role profilePhoto')
            .sort({ createdAt: -1 });

        res.status(200).json({ success: true, data: leaves });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// Handler helper for getting leave requests
const getLeaveRequestsHandler = async (req, res) => {
    try {
        const { status, academicYear, classId, role, search } = req.query;
        let query = {};

        if (status && status !== 'all') {
            query.status = status;
        }

        if (academicYear && academicYear !== 'all') {
            query.academicYear = academicYear;
        }

        if (classId && classId !== 'all') {
            query.class = classId;
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
                query.class = classId;
            } else {
                query.class = { $in: classIds };
            }
            query.applicantRole = 'student';
        } else if (req.user.role === 'admin') {
            // Admin sees leaves for Students (All), Teachers, and Staff
            const allowedAdminRoles = ['student', 'teacher', 'staff', 'support_staff'];
            if (role && role !== 'all') {
                if (role === 'staff_teachers') {
                    query.applicantRole = { $in: ['teacher', 'staff', 'support_staff'] };
                } else if (role === 'staff') {
                    query.applicantRole = { $in: ['staff', 'support_staff'] };
                } else if (allowedAdminRoles.includes(role)) {
                    query.applicantRole = role;
                } else {
                    query.applicantRole = { $in: allowedAdminRoles };
                }
            } else {
                query.applicantRole = { $in: allowedAdminRoles };
            }
        } else if (req.user.role === 'super admin') {
            // Super Admin sees ALL leaves (including Admins)
            const allowedSuperRoles = ['student', 'teacher', 'staff', 'support_staff', 'admin'];
            if (role && role !== 'all') {
                if (role === 'staff_teachers') {
                    query.applicantRole = { $in: ['teacher', 'staff', 'support_staff'] };
                } else if (role === 'staff') {
                    query.applicantRole = { $in: ['staff', 'support_staff'] };
                } else if (allowedSuperRoles.includes(role)) {
                    query.applicantRole = role;
                } else {
                    query.applicantRole = { $in: allowedSuperRoles };
                }
            } else {
                query.applicantRole = { $in: allowedSuperRoles };
            }
        }

        // Search text support
        if (search && search.trim()) {
            const cleanSearch = search.trim();
            const matchingUsers = await User.find({
                name: { $regex: cleanSearch, $options: 'i' }
            }).select('_id').lean();

            const userIds = matchingUsers.map(u => u._id);
            query.$or = [
                { applicant: { $in: userIds } },
                { reason: { $regex: cleanSearch, $options: 'i' } }
            ];
        }

        let leaves = await LeaveRequest.find(query)
            .populate('applicant', 'name role profilePhoto email phone currentClass')
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
        console.error(error);
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

        // Auto-mark attendance as absent if approved
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
            // Revert attendance (Delete the attendance record IF it was marked as Leave Approved)
            // This is a simplified revert. If the user was actually absent, this might delete that record too if it matches.
            // But generally, we want to remove the specific "Leave Approved" record.
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dateToMark = new Date(d);
                dateToMark.setHours(0, 0, 0, 0);

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
        notificationController.triggerNotification({
            title: `${statusEmoji} Leave Request ${statusLabel}`,
            message: `Your leave request for ${leaveRequest.startDate.toDateString()} has been ${status}. ${status === 'approved' ? 'Enjoy your time off!' : 'Please contact your teacher for more details.'}`,
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

// @desc    Get daily leave stats (Who is on leave today)
// @route   GET /api/leaves/daily-stats
// @access  Private (Admin, Super Admin)
router.get('/daily-stats', authenticateToken, checkRole(['admin', 'super admin']), async (req, res) => {
    try {
        const dateStr = req.query.date; // YYYY-MM-DD
        const { academicYear } = req.query;
        let targetDate = dateStr ? new Date(dateStr) : new Date();

        let query = {
            startDate: { $lte: targetDate },
            endDate: { $gte: targetDate },
            status: 'approved'
        };

        if (academicYear && academicYear !== 'all') {
            query.academicYear = academicYear;
        }

        // Find approved leaves that overlap with targetDate
        let leaves = await LeaveRequest.find(query)
            .populate('applicant', 'name role profilePhoto email phone currentClass')
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
        console.error(error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// @desc    Get leave balance
// @route   GET /api/leaves/balance
// @access  Private (Teacher, Admin, Super Admin)
router.get('/balance', authenticateToken, async (req, res) => {
    try {
        // Simple calculation: Total allowed (e.g., 12) - Approved Leaves this year
        // In a real app, "Total allowed" might come from a settings/policy collection
        const TOTAL_ALLOWED = 12;

        const currentYear = new Date().getFullYear();
        const startOfYear = new Date(currentYear, 0, 1);
        const endOfYear = new Date(currentYear, 11, 31);

        const approvedLeaves = await LeaveRequest.find({
            applicant: req.user.userId,
            status: 'approved',
            startDate: { $gte: startOfYear },
            endDate: { $lte: endOfYear }
        });

        let usedDays = 0;
        approvedLeaves.forEach(leave => {
            if (leave.leaveType === 'half') {
                usedDays += 0.5;
            } else {
                // Calculate days difference
                const diffTime = Math.abs(leave.endDate - leave.startDate);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
                usedDays += diffDays;
            }
        });

        res.status(200).json({
            success: true,
            data: {
                total: TOTAL_ALLOWED,
                used: usedDays,
                remaining: TOTAL_ALLOWED - usedDays
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

module.exports = router;
