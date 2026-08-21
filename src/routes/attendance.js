const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const LeaveRequest = require('../models/LeaveRequest');
const Event = require('../models/Event');
const { invalidateDashboardCaches } = require('../controllers/dashboardController');
const {
    getISTDateString,
    getISTDayBounds,
    validateAttendanceDate,
    isISTSunday
} = require('../utils/dateUtils');

const isAdminRole = (role) => role === 'admin' || role === 'super admin';
const hasObjectIdMatch = (ids = [], userId) => ids.some((id) => id && id.toString() === userId);

// Teachers must belong to the student's class (as classTeacher or subject teacher) to view attendance
const canAccessStudentAttendance = async (user, studentId) => {
    if (isAdminRole(user.role)) return true;
    if (user.role === 'student') return user.userId === studentId;
    if (user.role !== 'teacher') return false;

    // Load student's class
    const student = await User.findById(studentId).select('currentClass role').lean();
    if (!student || student.role !== 'student' || !student.currentClass) return false;

    const classId = student.currentClass.toString();

    // Check if teacher is the class teacher
    const classDoc = await Class.findById(classId).select('classTeacher').lean();
    if (classDoc && classDoc.classTeacher && classDoc.classTeacher.toString() === user.userId) return true;

    // Check if teacher teaches a subject in that class
    const subject = await Subject.findOne({ class: classId, teachers: user.userId }).select('_id').lean();
    return Boolean(subject);
};
const parsePagination = (queryPage, queryLimit) => {
    const page = Number.parseInt(queryPage, 10);
    const limit = Number.parseInt(queryLimit, 10);
    const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
    const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 30;
    return { page: safePage, limit: safeLimit };
};

// @route   POST /api/attendance/mark
// @desc    Mark attendance for students (bulk)
// @access  Private (Teacher)
router.post('/mark', [auth, yearContext, requireOpenYear], async (req, res) => {
    try {
        const { classId, subjectId, date, attendanceRecords } = req.body;
        const academicYearId = req.academicYearContext;

        // Validate teacher authorization
        const _teacherUser = await User.findById(req.user.userId);
        let isAuthorized = false;

        // Check if teacher
        const classData = await Class.findById(classId);
        if (isAdminRole(req.user.role)) {
            isAuthorized = true;
        } else if (classData && classData.classTeacher && classData.classTeacher.toString() === req.user.userId) {
            isAuthorized = true;
        }

        // Check if subject teacher
        if (subjectId && !isAuthorized) {
            const subjectData = await Subject.findById(subjectId);
            if (subjectData && subjectData.teachers && hasObjectIdMatch(subjectData.teachers, req.user.userId)) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({ message: 'Not authorized to mark attendance for this class/subject' });
        }

        // Server-side guard against marking attendance on Sundays and Holidays
        const validation = await validateAttendanceDate(date);
        if (!validation.allowed) {
            return res.status(400).json({ success: false, message: validation.reason });
        }

        const attendanceDate = validation.normalizedDate;

        const bulkOps = attendanceRecords.map(record => {
            const { studentId, status, remarks } = record;
            return {
                updateOne: {
                    filter: {
                        user: studentId,
                        class: classId,
                        date: attendanceDate,
                        academicYear: academicYearId,
                        subject: subjectId || null,
                        period: null
                    },
                    update: {
                        $set: {
                            status,
                            remarks: remarks || '',
                            markedBy: req.user.userId,
                            role: 'student',
                            subject: subjectId || null
                        }
                    },
                    upsert: true
                }
            };
        });

        if (bulkOps.length > 0) {
            await Attendance.bulkWrite(bulkOps, { ordered: false });
        }

        // Invalidate dashboard caches so stats update immediately
        invalidateDashboardCaches().catch(() => {});

        res.json({ message: 'Attendance marked successfully' });
    } catch (err) {
        console.error('Attendance Mark Error:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
});

// @route   POST /api/attendance/mark-staff
// @desc    Mark attendance for staff (Teachers)
// @access  Private (Admin)
router.post('/mark-staff', [auth, yearContext, requireOpenYear], async (req, res) => {
    try {
        // Check if admin
        if (req.user.role !== 'admin' && req.user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { date, attendanceRecords } = req.body; // Records: [{ userId, status, remarks }]
        const academicYearId = req.academicYearContext;

        // Server-side guard against marking attendance on Sundays and Holidays
        const validation = await validateAttendanceDate(date);
        if (!validation.allowed) {
            return res.status(400).json({ success: false, message: validation.reason });
        }

        const dateMidnight = validation.normalizedDate;

        // Pre-fetch roles for all users
        const userIds = attendanceRecords.map(r => r.userId);
        const users = await User.find({ _id: { $in: userIds } }).select('role');
        const roleMap = users.reduce((acc, user) => {
            acc[user._id.toString()] = user.role;
            return acc;
        }, {});

        const bulkOps = attendanceRecords.map(record => {
            const { userId, status, remarks } = record;
            return {
                updateOne: {
                    filter: {
                        user: userId,
                        academicYear: academicYearId,
                        date: dateMidnight
                    },
                    update: {
                        $set: {
                            status,
                            remarks: remarks || '',
                            markedBy: req.user.userId,
                            role: roleMap[userId] || 'teacher'
                        }
                    },
                    upsert: true
                }
            };
        });

        if (bulkOps.length > 0) {
            await Attendance.bulkWrite(bulkOps, { ordered: false });
        }

        // Invalidate dashboard caches so stats update immediately
        invalidateDashboardCaches().catch(() => {});

        res.json({ message: 'Staff attendance marked successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


// @route   GET /api/attendance/class/:classId/date/:date
// @desc    Get attendance for a class on specific date
// @access  Private (Teacher/Admin)
router.get('/class/:classId/date/:date', [auth, yearContext], async (req, res) => {
    try {
        const { classId, date } = req.params;
        const { subject, period } = req.query;
        const academicYearId = req.academicYearContext;
        const { startOfDay, endOfDay } = getISTDayBounds(date);

        const filter = {
            class: classId,
            academicYear: academicYearId,
            date: { $gte: startOfDay, $lte: endOfDay }
        };

        if (subject) filter.subject = subject;
        if (period) filter.period = parseInt(period);

        const attendance = await Attendance.find(filter)
            .populate('user', 'name email') // Changed from student to user
            .populate('markedBy', 'name')
            .populate('subject', 'name')
            .sort({ 'user.name': 1 });

        const students = await User.find({ currentClass: classId, role: 'student' })
            .select('name email')
            .sort({ name: 1 });

        // Check for approved leaves overlapping this date
        const approvedLeaves = await LeaveRequest.find({
            class: classId,
            applicantRole: 'student',
            status: 'approved',
            startDate: { $lte: endOfDay },
            endDate: { $gte: startOfDay }
        }).select('applicant reason leaveType');

        const onLeaveStudentIds = new Set(approvedLeaves.map(l => l.applicant.toString()));

        const result = students.map(student => {
            const attendanceRecord = attendance.find(a => a.user._id.toString() === student._id.toString());
            const leaveRecord = approvedLeaves.find(l => l.applicant.toString() === student._id.toString());
            return {
                student: {
                    _id: student._id,
                    name: student.name,
                    email: student.email
                },
                status: attendanceRecord ? attendanceRecord.status : null,
                remarks: attendanceRecord ? attendanceRecord.remarks : '',
                attendanceId: attendanceRecord ? attendanceRecord._id : null,
                onLeave: onLeaveStudentIds.has(student._id.toString()),
                leaveReason: leaveRecord ? leaveRecord.reason : null
            };
        });

        res.json(result);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/attendance/my-attendance
// @desc    Get my attendance history
// @access  Private (All)
router.get('/my-attendance', [auth, yearContext], async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const { page, limit } = parsePagination(req.query.page, req.query.limit);

        const filter = {
            user: req.user.userId,
            academicYear: req.academicYearContext
        };

        if (startDate || endDate) {
            filter.date = {};
            if (startDate) filter.date.$gte = new Date(startDate).setHours(0, 0, 0, 0);
            if (endDate) filter.date.$lte = new Date(endDate).setHours(23, 59, 59, 999);
        }

        // Fetch all records for accurate summary stats
        const allAttendance = await Attendance.find(filter)
            .select('date status remarks subject')
            .sort({ date: -1 })
            .lean();

        // Calculate summary over all records
        // Count late, excused, half-day as present to match the monthly breakdown calculation
        const totalRecords = allAttendance.length;
        const PRESENT_STATUSES = ['present', 'late', 'excused', 'half-day'];
        const presentCount = allAttendance.filter(a => PRESENT_STATUSES.includes(a.status)).length;
        const percentage = totalRecords > 0 ? ((presentCount / totalRecords) * 100).toFixed(2) : 0;

        // Calculate Monthly Breakdown
        const monthlyStats = {};
        allAttendance.forEach(record => {
            const date = new Date(record.date);
            const monthKey = date.toLocaleString('default', { month: 'long', year: 'numeric' });

            if (!monthlyStats[monthKey]) {
                monthlyStats[monthKey] = { total: 0, present: 0 };
            }

            monthlyStats[monthKey].total++;
            if (['present', 'late', 'excused', 'half-day'].includes(record.status)) {
                monthlyStats[monthKey].present++;
            }
        });

        const monthlyBreakdown = Object.keys(monthlyStats).map(key => ({
            month: key,
            total: monthlyStats[key].total,
            present: monthlyStats[key].present,
            percentage: ((monthlyStats[key].present / monthlyStats[key].total) * 100).toFixed(1)
        }));

        // Paginate the attendance list
        const totalPages = Math.ceil(totalRecords / limit);
        const attendance = allAttendance.slice((page - 1) * limit, page * limit);

        res.json({
            attendance,
            summary: {
                total: totalRecords,
                present: presentCount,
                absent: allAttendance.filter(a => a.status === 'absent').length,
                late: allAttendance.filter(a => a.status === 'late').length,
                excused: allAttendance.filter(a => a.status === 'excused').length,
                halfDay: allAttendance.filter(a => a.status === 'half-day').length,
                percentage: parseFloat(percentage),
                monthlyBreakdown
            },
            pagination: {
                page,
                limit,
                totalRecords,
                totalPages,
                hasMore: page < totalPages
            }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/attendance/student/:studentId/summary
// @desc    Get detailed attendance summary for a student
// @access  Private
router.get('/student/:studentId/summary', [auth, yearContext], async (req, res) => {
    try {
        const { studentId } = req.params;
        const academicYearId = req.academicYearContext;
        if (!(await canAccessStudentAttendance(req.user, studentId))) {
            return res.status(403).json({ message: 'Not authorized to view this student attendance summary' });
        }

        // 1. Overall Stats
        const allAttendance = await Attendance.find({
            user: studentId,
            academicYear: academicYearId
        });
        const totalClasses = allAttendance.length;
        const presentClasses = allAttendance.filter(a => ['present', 'late', 'excused', 'half-day'].includes(a.status)).length;
        const overallPercentage = totalClasses > 0 ? ((presentClasses / totalClasses) * 100).toFixed(1) : 0;

        // 2. Subject-wise Stats
        const subjectStats = {};

        // Pre-fetch all subjects to get names
        const subjects = await Subject.find({});
        const subjectMap = subjects.reduce((acc, sub) => {
            acc[sub._id.toString()] = sub.name;
            return acc;
        }, {});

        allAttendance.forEach(record => {
            const subjectId = record.subject ? record.subject.toString() : 'class_attendance';
            const subjectName = record.subject ? (subjectMap[subjectId] || 'Unknown Subject') : 'Class Attendance';

            if (!subjectStats[subjectId]) {
                subjectStats[subjectId] = {
                    subjectId,
                    name: subjectName,
                    total: 0,
                    present: 0
                };
            }

            subjectStats[subjectId].total++;
            if (['present', 'late', 'excused', 'half-day'].includes(record.status)) {
                subjectStats[subjectId].present++;
            }
        });

        const subjectWise = Object.values(subjectStats).map(stat => ({
            ...stat,
            percentage: stat.total > 0 ? ((stat.present / stat.total) * 100).toFixed(1) : 0
        }));

        // 3. Monthly Breakdown
        const monthlyStats = {};
        allAttendance.forEach(record => {
            const date = new Date(record.date);
            const monthKey = date.toLocaleString('default', { month: 'long', year: 'numeric' });

            if (!monthlyStats[monthKey]) {
                monthlyStats[monthKey] = { month: monthKey, total: 0, present: 0 };
            }

            monthlyStats[monthKey].total++;
            if (['present', 'late', 'excused', 'half-day'].includes(record.status)) {
                monthlyStats[monthKey].present++;
            }
        });

        const monthlyBreakdown = Object.values(monthlyStats).map(stat => ({
            ...stat,
            percentage: stat.total > 0 ? ((stat.present / stat.total) * 100).toFixed(1) : 0
        }));

        res.json({
            overall: {
                total: totalClasses,
                present: presentClasses,
                percentage: overallPercentage
            },
            subjectWise,
            monthlyBreakdown
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/attendance/student/:studentId
// @desc    Get student's attendance history (Legacy/Admin view)
// @access  Private (Student/Teacher/Admin)
router.get('/student/:studentId', [auth, yearContext], async (req, res) => {
    try {
        const { studentId } = req.params;
        const { startDate, endDate, subject } = req.query;
        if (!(await canAccessStudentAttendance(req.user, studentId))) {
            return res.status(403).json({ message: 'Not authorized to view this student attendance' });
        }
        const { page, limit } = parsePagination(req.query.page, req.query.limit);
        const academicYearId = req.academicYearContext;

        const filter = {
            user: studentId,
            academicYear: academicYearId
        };

        if (startDate || endDate) {
            filter.date = {};
            if (startDate) filter.date.$gte = new Date(startDate).setHours(0, 0, 0, 0);
            if (endDate) filter.date.$lte = new Date(endDate).setHours(23, 59, 59, 999);
        }

        if (subject) filter.subject = subject;

        // Fetch all records for accurate summary stats
        const allAttendance = await Attendance.find(filter)
            .populate('class', 'name section')
            .populate('subject', 'name')
            .populate('markedBy', 'name')
            .sort({ date: -1 })
            .lean();

        const totalRecords = allAttendance.length;
        const PRESENT_STATUSES = ['present', 'late', 'excused', 'half-day'];
        const presentCount = allAttendance.filter(a => PRESENT_STATUSES.includes(a.status)).length;
        const percentage = totalRecords > 0 ? ((presentCount / totalRecords) * 100).toFixed(2) : 0;

        // Paginate
        const totalPages = Math.ceil(totalRecords / limit);
        const attendance = allAttendance.slice((page - 1) * limit, page * limit);

        res.json({
            attendance,
            summary: {
                total: totalRecords,
                present: presentCount,
                absent: allAttendance.filter(a => a.status === 'absent').length,
                late: allAttendance.filter(a => a.status === 'late').length,
                excused: allAttendance.filter(a => a.status === 'excused').length,
                halfDay: allAttendance.filter(a => a.status === 'half-day').length,
                percentage: parseFloat(percentage)
            },
            pagination: {
                page,
                limit,
                totalRecords,
                totalPages,
                hasMore: page < totalPages
            }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/attendance/staff-list
// @desc    Get list of staff with their attendance for a specific date
// @access  Private (Admin)
router.get('/staff-list', [auth, yearContext], async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { date } = req.query;
        const { startOfDay, endOfDay } = getISTDayBounds(date || new Date());
        const academicYearId = req.academicYearContext;

        // Get all staff (teachers, staff, support_staff) — consistent with mark-staff endpoint
        const teachers = await User.find({ role: { $in: ['teacher', 'staff', 'support_staff'] } }).select('name email phone role');

        // Get attendance for this date
        const attendance = await Attendance.find({
            date: { $gte: startOfDay, $lte: endOfDay },
            role: { $in: ['teacher', 'staff', 'support_staff'] },
            academicYear: academicYearId
        });

        const result = teachers.map(teacher => {
            const record = attendance.find(a => a.user.toString() === teacher._id.toString());
            return {
                user: teacher,
                status: record ? record.status : null,
                remarks: record ? record.remarks : '',
                attendanceId: record ? record._id : null
            };
        });

        res.json({ success: true, data: result });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


// @route   GET /api/attendance/school-summary
// @desc    Get school-wide attendance summary
// @access  Private (Admin/Super Admin)
router.get('/school-summary', [auth, yearContext], async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { date } = req.query;
        const { startOfDay, endOfDay } = getISTDayBounds(date || new Date());
        const academicYearId = req.academicYearContext;

        // 1. Get Total Counts
        const totalStudents = await User.countDocuments({ role: 'student', academicYear: academicYearId });
        const totalTeachers = await User.countDocuments({ role: 'teacher' }); // Teachers aren't year-bound typically for counts

        // 2. Get Attendance for Target Date
        const attendanceRecords = await Attendance.find({
            date: { $gte: startOfDay, $lte: endOfDay },
            role: { $in: ['student', 'teacher'] },
            academicYear: academicYearId
        }).populate({
            path: 'user',
            select: 'name role currentClass',
            populate: {
                path: 'currentClass',
                select: 'name section'
            }
        });

        // 3. Calculate Stats
        let studentPresent = 0;
        let teacherPresent = 0;
        const absentList = [];

        // Map attendance to find who is present/absent
        attendanceRecords.forEach(record => {
            if (record.role === 'student') {
                if (['present', 'late', 'excused', 'half-day'].includes(record.status)) {
                    studentPresent++;
                } else if (record.status === 'absent') {
                    absentList.push({
                        _id: record.user?._id || 'unknown',
                        name: record.user?.name || 'Unknown User',
                        role: 'Student',
                        className: record.user?.currentClass
                            ? `${record.user.currentClass.name} ${record.user.currentClass.section}`
                            : 'No Class',
                        status: 'Absent',
                        remarks: record.remarks
                    });
                }
            } else if (record.role === 'teacher') {
                if (['present', 'late', 'excused', 'half-day'].includes(record.status)) {
                    teacherPresent++;
                } else if (record.status === 'absent') {
                    absentList.push({
                        _id: record.user?._id || 'unknown',
                        name: record.user?.name || 'Unknown User',
                        role: 'Teacher',
                        className: '-',
                        status: 'Absent',
                        remarks: record.remarks
                    });
                }
            }
        });

        // If we want to include "Not Marked" as absent in the list, we'd need to fetch all users and compare.
        // For now, let's stick to explicitly marked absent for the list, 
        // but for the counts, "Present" is accurate. 
        // "Absent" count in summary could be (Total - Present).

        res.json({
            success: true,
            data: {
                students: {
                    total: totalStudents,
                    present: studentPresent,
                    absent: totalStudents - studentPresent // This assumes unmarked = absent/unknown
                },
                teachers: {
                    total: totalTeachers,
                    present: teacherPresent,
                    absent: totalTeachers - teacherPresent
                },
                absentList // Only explicitly marked absent
            }
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/attendance/classes-marked
// @desc    Get list of class IDs that have attendance marked for a specific date
// @access  Private
router.get('/classes-marked', [auth, yearContext], async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) return res.status(400).json({ message: 'Date is required' });

        const { startOfDay, endOfDay } = getISTDayBounds(date);

        const markedClasses = await Attendance.distinct('class', {
            date: { $gte: startOfDay, $lte: endOfDay },
            role: 'student',
            class: { $ne: null },
            academicYear: req.academicYearContext
        });

        res.json({ success: true, markedClasses });
    } catch (err) {
        console.error('Classes Marked Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route   GET /api/attendance/missing-tracker
// @desc    Get missing attendance tracking data
// @access  Private (Admin/Teacher)
router.get('/missing-tracker', [auth, yearContext], async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) return res.status(400).json({ message: 'Start and end dates are required' });

        const { startOfDay: start } = getISTDayBounds(startDate);
        const { endOfDay: end } = getISTDayBounds(endDate);

        // Filter valid working days (assuming Monday-Saturday in IST)
        // Exclude today since attendance may not be taken yet
        const todayStr = getISTDateString(new Date());
        const { startOfDay: todayStart } = getISTDayBounds(todayStr);
        const effectiveEnd = end >= todayStart ? new Date(todayStart.getTime() - 1) : end;

        // Fetch custom holidays in range
        const holidaysRaw = await Event.distinct('date', {
            isHoliday: true,
            date: { $gte: start, $lte: effectiveEnd }
        });
        const holidayDates = holidaysRaw.map(d => getISTDateString(d));

        const daysInRange = [];
        for (let d = new Date(start); d <= effectiveEnd; d.setDate(d.getDate() + 1)) {
            // Skip Sundays for standard school
            const ds = getISTDateString(d);
            if (!isISTSunday(d) && !holidayDates.includes(ds)) {
                daysInRange.push(new Date(d));
            }
        }

        if (req.user.role === 'teacher' || req.user.role === 'staff' || req.user.role === 'support_staff') {
            // Find class where teacher is classTeacher
            const assignedClass = await Class.findOne({ classTeacher: req.user.userId }).lean();
            if (!assignedClass) {
                return res.json({ success: true, missingDays: [] });
            }

            // Find days marked for this class
            const markedDaysRaw = await Attendance.distinct('date', {
                class: assignedClass._id,
                role: 'student',
                date: { $gte: start, $lte: end },
                academicYear: req.academicYearContext
            });
            const markedDays = markedDaysRaw.map(d => getISTDateString(d));

            const missingDays = daysInRange
                .map(d => getISTDateString(d))
                .filter(d => !markedDays.includes(d));

            // Sort missing days newest first
            missingDays.sort((a, b) => new Date(b) - new Date(a));

            return res.json({
                success: true,
                classId: assignedClass._id,
                className: `${assignedClass.name} ${assignedClass.section}`,
                missingDays
            });
        } else if (req.user.role === 'admin' || req.user.role === 'super admin') {
            // For admin, we want to know for each day, which classes are MISSING
            const allClasses = await Class.find({}).select('name section').lean();

            const attendanceAgg = await Attendance.aggregate([
                {
                    $match: {
                        role: 'student',
                        class: { $ne: null },
                        date: { $gte: start, $lte: effectiveEnd },
                        academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                    }
                },
                {
                    $group: {
                        _id: {
                            date: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                            class: "$class"
                        }
                    }
                }
            ]);

            const dateClassMap = {}; // { '2023-10-01': [classId1, classId2] }
            attendanceAgg.forEach(item => {
                const d = item._id.date;
                const c = item._id.class.toString();
                if (!dateClassMap[d]) dateClassMap[d] = [];
                dateClassMap[d].push(c);
            });

            const missingData = [];
            daysInRange.forEach(dObj => {
                const dateStr = getISTDateString(dObj);
                const markedForDay = dateClassMap[dateStr] || [];
                const missingClasses = allClasses.filter(c => !markedForDay.includes(c._id.toString()));

                missingData.push({
                    date: dateStr,
                    missingCount: missingClasses.length,
                    totalCount: allClasses.length,
                    missingClasses: missingClasses
                });
            });

            // Sort newest first
            missingData.sort((a, b) => new Date(b.date) - new Date(a.date));

            return res.json({ success: true, missingData });
        } else {
            return res.status(403).json({ message: 'Not authorized' });
        }

    } catch (err) {
        console.error('Missing Tracker Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;
