const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const Class = require('../models/Class');
const Subject = require('../models/Subject');

// @route   POST /api/attendance/mark
// @desc    Mark attendance for students (bulk)
// @access  Private (Teacher)
router.post('/mark', auth, async (req, res) => {
    try {
        const { classId, subjectId, date, attendanceRecords } = req.body;

        // Validate teacher authorization
        const _teacherUser = await User.findById(req.user.userId);
        let isAuthorized = false;

        // Check if teacher
        const classData = await Class.findById(classId);
        if (req.user.role === 'admin' || req.user.role === 'super admin') {
            isAuthorized = true;
        } else if (classData && classData.classTeacher && classData.classTeacher.toString() === req.user.userId) {
            isAuthorized = true;
        }

        // Check if subject teacher
        if (subjectId && !isAuthorized) {
            const subjectData = await Subject.findById(subjectId);
            if (subjectData && subjectData.teachers && subjectData.teachers.includes(req.user.userId)) {
                isAuthorized = true;
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({ message: 'Not authorized to mark attendance for this class/subject' });
        }

        for (const record of attendanceRecords) {
            const { studentId, status, remarks, _period } = record;
            // Ensure date is a Date object, not a timestamp number
            const attendanceDate = new Date(date);
            attendanceDate.setHours(0, 0, 0, 0);

            const filter = {
                user: studentId,
                class: classId,
                date: attendanceDate,
                subject: null,
                period: null
            };

            const existingAttendance = await Attendance.findOne(filter);

            if (existingAttendance) {
                existingAttendance.status = status;
                existingAttendance.remarks = remarks || '';
                existingAttendance.markedBy = req.user.userId;
                await existingAttendance.save();
            } else {
                const attendance = new Attendance({
                    user: studentId,
                    role: 'student',
                    class: classId,
                    subject: null, // Always null for class attendance
                    date: attendanceDate,
                    status,
                    markedBy: req.user.userId,
                    period: null, // Always null for class attendance
                    remarks: remarks || ''
                });
                await attendance.save();
            }
        }

        res.json({ message: 'Attendance marked successfully' });
        res.json({ message: 'Attendance marked successfully' });
    } catch (err) {
        console.error('Attendance Mark Error:', err);
        res.status(500).json({ message: 'Server Error', error: err.message });
    }
});

// @route   POST /api/attendance/mark-staff
// @desc    Mark attendance for staff (Teachers)
// @access  Private (Admin)
router.post('/mark-staff', auth, async (req, res) => {
    try {
        // Check if admin
        if (req.user.role !== 'admin' && req.user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { date, attendanceRecords } = req.body; // Records: [{ userId, status, remarks }]

        const attendancePromises = attendanceRecords.map(async (record) => {
            const { userId, status, remarks } = record;

            const filter = {
                user: userId,
                date: new Date(date).setHours(0, 0, 0, 0)
            };

            const existingAttendance = await Attendance.findOne(filter);

            if (existingAttendance) {
                existingAttendance.status = status;
                existingAttendance.remarks = remarks || '';
                existingAttendance.markedBy = req.user.userId;
                return await existingAttendance.save();
            } else {
                // Fetch user to get role
                const user = await User.findById(userId);
                const attendance = new Attendance({
                    user: userId,
                    role: user.role, // 'teacher' or others
                    date: new Date(date).setHours(0, 0, 0, 0),
                    status,
                    markedBy: req.user.userId,
                    remarks: remarks || ''
                });
                return await attendance.save();
            }
        });

        await Promise.all(attendancePromises);
        res.json({ message: 'Staff attendance marked successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


// @route   GET /api/attendance/class/:classId/date/:date
// @desc    Get attendance for a class on specific date
// @access  Private (Teacher/Admin)
router.get('/class/:classId/date/:date', auth, async (req, res) => {
    try {
        const { classId, date } = req.params;
        const { subject, period } = req.query;

        const filter = {
            class: classId,
            date: new Date(date).setHours(0, 0, 0, 0)
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

        const result = students.map(student => {
            const attendanceRecord = attendance.find(a => a.user._id.toString() === student._id.toString());
            return {
                student: { // Keep key as 'student' for frontend compatibility
                    _id: student._id,
                    name: student.name,
                    email: student.email
                },
                status: attendanceRecord ? attendanceRecord.status : null,
                remarks: attendanceRecord ? attendanceRecord.remarks : '',
                attendanceId: attendanceRecord ? attendanceRecord._id : null
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
router.get('/my-attendance', auth, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const filter = { user: req.user.userId };

        if (startDate || endDate) {
            filter.date = {};
            if (startDate) filter.date.$gte = new Date(startDate).setHours(0, 0, 0, 0);
            if (endDate) filter.date.$lte = new Date(endDate).setHours(23, 59, 59, 999);
        }

        const attendance = await Attendance.find(filter)
            .sort({ date: -1 });

        // Calculate summary
        const totalRecords = attendance.length;
        const presentCount = attendance.filter(a => a.status === 'present').length;
        const percentage = totalRecords > 0 ? ((presentCount / totalRecords) * 100).toFixed(2) : 0;

        // Calculate Monthly Breakdown
        const monthlyStats = {};
        attendance.forEach(record => {
            const date = new Date(record.date);
            const monthKey = date.toLocaleString('default', { month: 'long', year: 'numeric' });

            if (!monthlyStats[monthKey]) {
                monthlyStats[monthKey] = { total: 0, present: 0 };
            }

            monthlyStats[monthKey].total++;
            if (record.status === 'present' || record.status === 'late' || record.status === 'excused') {
                monthlyStats[monthKey].present++;
            }
        });

        const monthlyBreakdown = Object.keys(monthlyStats).map(key => ({
            month: key,
            total: monthlyStats[key].total,
            present: monthlyStats[key].present,
            percentage: ((monthlyStats[key].present / monthlyStats[key].total) * 100).toFixed(1)
        }));

        res.json({
            attendance,
            summary: {
                total: totalRecords,
                present: presentCount,
                absent: attendance.filter(a => a.status === 'absent').length,
                late: attendance.filter(a => a.status === 'late').length,
                excused: attendance.filter(a => a.status === 'excused').length,
                percentage: parseFloat(percentage),
                monthlyBreakdown // Added monthly breakdown
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
router.get('/student/:studentId/summary', auth, async (req, res) => {
    try {
        const { studentId } = req.params;

        // 1. Overall Stats
        const allAttendance = await Attendance.find({ user: studentId });
        const totalClasses = allAttendance.length;
        const presentClasses = allAttendance.filter(a => ['present', 'late', 'excused'].includes(a.status)).length;
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
            if (['present', 'late', 'excused'].includes(record.status)) {
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
            if (['present', 'late', 'excused'].includes(record.status)) {
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
router.get('/student/:studentId', auth, async (req, res) => {
    try {
        const { studentId } = req.params;
        const { startDate, endDate, subject } = req.query;

        const filter = { user: studentId }; // Changed from student to user

        if (startDate || endDate) {
            filter.date = {};
            if (startDate) filter.date.$gte = new Date(startDate).setHours(0, 0, 0, 0);
            if (endDate) filter.date.$lte = new Date(endDate).setHours(23, 59, 59, 999);
        }

        if (subject) filter.subject = subject;

        const attendance = await Attendance.find(filter)
            .populate('class', 'name section')
            .populate('subject', 'name')
            .populate('markedBy', 'name')
            .sort({ date: -1 });

        const totalRecords = attendance.length;
        const presentCount = attendance.filter(a => a.status === 'present').length;
        const percentage = totalRecords > 0 ? ((presentCount / totalRecords) * 100).toFixed(2) : 0;

        res.json({
            attendance,
            summary: {
                total: totalRecords,
                present: presentCount,
                absent: attendance.filter(a => a.status === 'absent').length,
                late: attendance.filter(a => a.status === 'late').length,
                excused: attendance.filter(a => a.status === 'excused').length,
                percentage: parseFloat(percentage)
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
router.get('/staff-list', auth, async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { date } = req.query;
        const targetDate = date ? new Date(date).setHours(0, 0, 0, 0) : new Date().setHours(0, 0, 0, 0);

        // Get all teachers
        const teachers = await User.find({ role: 'teacher' }).select('name email phone');

        // Get attendance for this date
        const attendance = await Attendance.find({
            date: targetDate,
            role: 'teacher'
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
router.get('/school-summary', auth, async (req, res) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { date } = req.query;
        const targetDate = date ? new Date(date) : new Date();
        targetDate.setHours(0, 0, 0, 0);

        // 1. Get Total Counts
        const totalStudents = await User.countDocuments({ role: 'student' });
        const totalTeachers = await User.countDocuments({ role: 'teacher' });

        // 2. Get Attendance for Target Date
        const attendanceRecords = await Attendance.find({
            date: targetDate,
            role: { $in: ['student', 'teacher'] }
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
                if (['present', 'late', 'excused'].includes(record.status)) {
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
                if (['present', 'late', 'excused'].includes(record.status)) {
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

module.exports = router;
