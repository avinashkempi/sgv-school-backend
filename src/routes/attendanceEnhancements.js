const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');
const { canAccessClass, requireStudentAccessParam } = require('../middleware/accessControl');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const {
    getISTDateString,
    validateAttendanceDate
} = require('../utils/dateUtils');

// @route   POST /api/attendance/bulk-quick-mark
// @desc    Quick mark all students as present/absent with exceptions
// @access  Private (Teacher/Admin)
router.post('/bulk-quick-mark', [auth, yearContext, requireOpenYear], async (req, res) => {
    try {
        const { classId, date, defaultStatus, exceptions } = req.body;
        // defaultStatus: 'present' or 'absent'
        // exceptions: [{ studentId, status, remarks }]

        if (!(await canAccessClass(req.user, classId))) {
            return res.status(403).json({ success: false, message: 'Not authorized to mark attendance for this class' });
        }

        if (!['present', 'absent', 'late', 'excused', 'half-day'].includes(defaultStatus)) {
            return res.status(400).json({ success: false, message: 'Invalid default attendance status' });
        }

        const invalidException = exceptions?.find(e => !['present', 'absent', 'late', 'excused', 'half-day'].includes(e.status));
        if (invalidException) {
            return res.status(400).json({ success: false, message: 'Invalid exception attendance status' });
        }

        // Server-side guard against marking attendance on Sundays and Holidays
        const validation = await validateAttendanceDate(date);
        if (!validation.allowed) {
            return res.status(400).json({ success: false, message: validation.reason });
        }

        const attendanceDate = validation.normalizedDate;

        // Get all students in class
        const students = await User.find({ currentClass: classId, role: 'student' }).select('_id');

        // Create attendance records
        const attendanceRecords = students.map(student => {
            const exception = exceptions?.find(e => e.studentId === student._id.toString());

            return {
                user: student._id,
                role: 'student',
                class: classId,
                date: attendanceDate,
                status: exception ? exception.status : defaultStatus,
                remarks: exception ? (exception.remarks || '') : '',
                markedBy: req.user.userId,
                academicYear: req.academicYearContext
            };
        });

        // Bulk upsert
        for (const record of attendanceRecords) {
            await Attendance.findOneAndUpdate(
                {
                    user: record.user,
                    class: record.class,
                    date: record.date,
                    subject: null,
                    period: null,
                    academicYear: req.academicYearContext
                },
                record,
                { upsert: true, new: true, runValidators: true }
            );
        }

        res.json({
            success: true,
            message: `Attendance marked for ${students.length} students`,
            count: students.length
        });
    } catch (err) {
        console.error('Bulk Quick Mark Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/attendance/calendar/:classId
// @desc    Get attendance data for calendar view (month)
// @access  Private
router.get('/calendar/:classId', auth, async (req, res) => {
    try {
        const { classId } = req.params;
        const { month, year } = req.query;

        const targetMonth = month ? parseInt(month) - 1 : new Date().getMonth();
        const targetYear = year ? parseInt(year) : new Date().getFullYear();

        const startDate = new Date(targetYear, targetMonth, 1);
        const endDate = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);

        const attendance = await Attendance.find({
            class: classId,
            date: { $gte: startDate, $lte: endDate }
        }).lean();

        // Get students count
        const studentCount = await User.countDocuments({ currentClass: classId, role: 'student' });

        // Group by date
        const calendar = {};
        attendance.forEach(record => {
            const dateKey = getISTDateString(record.date);
            if (!calendar[dateKey]) {
                calendar[dateKey] = {
                    date: dateKey,
                    total: 0,
                    present: 0,
                    absent: 0,
                    late: 0,
                    excused: 0
                };
            }

            calendar[dateKey].total++;
            calendar[dateKey][record.status]++;
        });

        // Calculate percentages
        const calendarData = Object.values(calendar).map(day => ({
            ...day,
            percentage: studentCount > 0 ? ((day.present / studentCount) * 100).toFixed(1) : 0,
            marked: day.total > 0
        }));

        res.json({
            success: true,
            calendarData,
            studentCount,
            month: targetMonth + 1,
            year: targetYear
        });
    } catch (err) {
        console.error('Calendar Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/attendance/low-attendance-alerts
// @desc    Get students with attendance below threshold (default 90%)
// @access  Private (Teacher/Admin)
router.get('/low-attendance-alerts', auth, async (req, res) => {
    try {
        const { classId, threshold = 90, days = 30 } = req.query;

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(days));
        startDate.setHours(0, 0, 0, 0);

        if (classId) {
            if (!(await canAccessClass(req.user, classId))) {
                return res.status(403).json({ success: false, message: 'Not authorized' });
            }
        } else if (!['admin', 'super admin'].includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Class filter is required for teachers' });
        }

        // Get all students in class
        let studentQuery = { role: 'student' };
        if (classId) studentQuery.currentClass = classId;

        const students = await User.find(studentQuery).populate('currentClass', 'name section').lean();

        const alerts = [];

        for (const student of students) {
            const attendanceRecords = await Attendance.find({
                user: student._id,
                date: { $gte: startDate }
            }).lean();

            const totalDays = attendanceRecords.length;
            if (totalDays === 0) continue;

            const presentDays = attendanceRecords.filter(a =>
                ['present', 'late', 'excused', 'half-day'].includes(a.status)
            ).length;

            const percentage = (presentDays / totalDays) * 100;

            if (percentage < parseFloat(threshold)) {
                alerts.push({
                    student: {
                        _id: student._id,
                        name: student.name,
                        email: student.email,
                        phone: student.phone,
                        class: student.currentClass
                    },
                    attendance: {
                        totalDays,
                        presentDays,
                        absentDays: totalDays - presentDays,
                        percentage: percentage.toFixed(1)
                    },
                    severity: percentage < 75 ? 'critical' : percentage < 85 ? 'high' : 'medium'
                });
            }
        }

        // Sort by percentage (lowest first)
        alerts.sort((a, b) => a.attendance.percentage - b.attendance.percentage);

        res.json({
            success: true,
            alerts,
            count: alerts.length,
            threshold: parseFloat(threshold),
            period: `Last ${days} days`
        });
    } catch (err) {
        console.error('Low Attendance Alerts Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/attendance/trends/:studentId
// @desc    Get attendance trends for a student
// @access  Private
router.get('/trends/:studentId', [auth, requireStudentAccessParam('studentId')], async (req, res) => {
    try {
        const { studentId } = req.params;
        const { period = 'monthly' } = req.query; // 'weekly', 'monthly', 'yearly'

        const attendance = await Attendance.find({
            user: studentId
        }).sort({ date: 1 }).lean();

        let trends = [];

        if (period === 'weekly') {
            // Group by week
            const weeklyData = {};
            attendance.forEach(record => {
                const date = new Date(record.date);
                const weekKey = getWeekKey(date);

                if (!weeklyData[weekKey]) {
                    weeklyData[weekKey] = { week: weekKey, total: 0, present: 0 };
                }

                weeklyData[weekKey].total++;
                if (['present', 'late', 'excused', 'half-day'].includes(record.status)) {
                    weeklyData[weekKey].present++;
                }
            });

            trends = Object.values(weeklyData).map(week => ({
                ...week,
                percentage: week.total > 0 ? ((week.present / week.total) * 100).toFixed(1) : 0
            }));
        } else if (period === 'monthly') {
            // Group by month
            const monthlyData = {};
            attendance.forEach(record => {
                const date = new Date(record.date);
                const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

                if (!monthlyData[monthKey]) {
                    monthlyData[monthKey] = {
                        month: monthKey,
                        label: date.toLocaleString('default', { month: 'short', year: 'numeric' }),
                        total: 0,
                        present: 0
                    };
                }

                monthlyData[monthKey].total++;
                if (['present', 'late', 'excused', 'half-day'].includes(record.status)) {
                    monthlyData[monthKey].present++;
                }
            });

            trends = Object.values(monthlyData).map(month => ({
                ...month,
                percentage: month.total > 0 ? ((month.present / month.total) * 100).toFixed(1) : 0
            }));
        } else if (period === 'yearly') {
            // Group by year
            const yearlyData = {};
            attendance.forEach(record => {
                const date = new Date(record.date);
                const yearKey = date.getFullYear().toString();

                if (!yearlyData[yearKey]) {
                    yearlyData[yearKey] = { year: yearKey, total: 0, present: 0 };
                }

                yearlyData[yearKey].total++;
                if (['present', 'late', 'excused', 'half-day'].includes(record.status)) {
                    yearlyData[yearKey].present++;
                }
            });

            trends = Object.values(yearlyData).map(year => ({
                ...year,
                percentage: year.total > 0 ? ((year.present / year.total) * 100).toFixed(1) : 0
            }));
        }

        res.json({
            success: true,
            trends,
            period
        });
    } catch (err) {
        console.error('Attendance Trends Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// Helper function to get week key
function getWeekKey(date) {
    const startOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date - startOfYear) / 86400000;
    const weekNum = Math.ceil((pastDaysOfYear + startOfYear.getDay() + 1) / 7);
    return `${date.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

module.exports = router;
