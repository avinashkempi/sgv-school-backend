const express = require('express');
const router = express.Router();
const LeaveRequest = require('../models/LeaveRequest');
const User = require('../models/User');
const Class = require('../models/Class');
const Attendance = require('../models/Attendance');
const AcademicYear = require('../models/AcademicYear');
const { authenticateToken, checkRole } = require('../middleware/auth');
const notificationController = require('../controllers/notificationController');

// @desc    Apply for leave
// @route   POST /api/leaves/apply
// @access  Private (All)
router.post('/apply', authenticateToken, async (req, res) => {
    try {
        const { startDate, endDate, reason, leaveType, halfDaySlot } = req.body;

        // Log request for debugging


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
        if (req.user.role === 'student') {
            if (!user.currentClass) {
                return res.status(400).json({ success: false, message: 'Student is not assigned to any class' });
            }
            classId = user.currentClass;
        }

        const leaveRequest = await LeaveRequest.create({
            applicant: req.user.userId,
            applicantRole: req.user.role,
            class: classId,
            startDate: start,
            endDate: end,
            reason,
            leaveType: leaveType || 'full',
            halfDaySlot: leaveType === 'half' ? halfDaySlot : undefined
        });

        res.status(201).json({ success: true, data: leaveRequest });

        // Trigger Notification — send only to the concerned approver(s)
        try {
            if (req.user.role === 'student') {
                // Student leave: notify ONLY the class teacher of the student's class
                const classObj = await Class.findById(classId).select('classTeacher').lean();
                if (classObj?.classTeacher) {
                    notificationController.triggerNotification({
                        title: 'New Leave Request',
                        message: `${user.name} has applied for leave from ${startDate} to ${endDate}.`,
                        type: 'Emergency',
                        target: 'user',
                        targetId: classObj.classTeacher,
                        metadata: { leaveId: leaveRequest._id }
                    });
                }
            } else if (req.user.role === 'teacher') {
                // Teacher leave: notify all admins
                notificationController.triggerNotification({
                    title: 'New Leave Request',
                    message: `${user.name} (Teacher) has applied for leave from ${startDate} to ${endDate}.`,
                    type: 'Emergency',
                    target: 'admin',
                    metadata: { leaveId: leaveRequest._id }
                });
            } else if (req.user.role === 'admin') {
                // Admin leave: notify all super admins
                notificationController.triggerNotification({
                    title: 'New Leave Request',
                    message: `${user.name} (Admin) has applied for leave from ${startDate} to ${endDate}.`,
                    type: 'Emergency',
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
        const leaves = await LeaveRequest.find({ applicant: req.user.userId })
            .sort({ createdAt: -1 });

        res.status(200).json({ success: true, data: leaves });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// @desc    Get leave requests (Role based) with filters
// @route   GET /api/leaves/requests
// @access  Private (Teacher, Admin, Super Admin)
router.get('/requests', authenticateToken, checkRole(['teacher', 'admin', 'super admin']), async (req, res) => {
    try {
        const { status } = req.query; // 'pending', 'approved', 'rejected', or undefined (all)
        let query = {};

        if (status) {
            query.status = status;
        }

        if (req.user.role === 'teacher') {
            // Teacher sees pending leaves for students in their class
            const classObj = await Class.findOne({ classTeacher: req.user.userId });
            if (!classObj) {
                return res.status(200).json({ success: true, data: [] }); // No class assigned
            }
            query.class = classObj._id;
            query.applicantRole = 'student';
        } else if (req.user.role === 'admin') {
            // Admin sees pending leaves for Students (All) AND Teachers
            query.applicantRole = { $in: ['student', 'teacher'] };
        } else if (req.user.role === 'super admin') {
            // Super Admin sees ALL pending leaves (including Admins)
            query.applicantRole = { $in: ['student', 'teacher', 'admin'] };
        }


        const leaves = await LeaveRequest.find(query)
            .populate('applicant', 'name role')
            .populate('class', 'name section')
            .sort({ createdAt: -1 });


        res.status(200).json({ success: true, data: leaves });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
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
            // Student leave: Teacher OR Admin OR Super Admin can approve
            if (req.user.role === 'teacher') {
                // Check if it's their class
                if (leaveRequest.class) {
                    const classObj = await Class.findOne({ classTeacher: req.user.userId });
                    if (classObj && classObj._id.toString() === leaveRequest.class.toString()) {
                        isAuthorized = true;
                    }
                }
            } else if (['admin', 'super admin'].includes(req.user.role)) {
                isAuthorized = true;
            }
        } else if (applicantRole === 'teacher') {
            // Teacher leave: Admin OR Super Admin can approve
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
                    const dateToMark = new Date(d);
                    dateToMark.setHours(0, 0, 0, 0);

                    // Skip Sundays
                    if (dateToMark.getDay() === 0) continue;

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

        // Trigger Notification for Student
        notificationController.triggerNotification({
            title: `Leave Request ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            message: `Your leave request for ${leaveRequest.startDate.toDateString()} has been ${status}.`,
            type: 'General',
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
        let targetDate = dateStr ? new Date(dateStr) : new Date();

        // Find approved leaves that overlap with targetDate
        const leaves = await LeaveRequest.find({
            startDate: { $lte: targetDate },
            endDate: { $gte: targetDate },
            status: 'approved'
        }).populate('applicant', 'name role')
            .populate('class', 'name section');

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
