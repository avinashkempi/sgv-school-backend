const User = require('../models/User');
const Attendance = require('../models/Attendance');
const FeePayment = require('../models/FeePayment');
const Complaint = require('../models/Complaint');
const Marks = require('../models/Marks');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const Exam = require('../models/Exam');
const AcademicYear = require('../models/AcademicYear');

// Helper to get active academic year
const getActiveYear = async () => {
    return await AcademicYear.findOne({ isActive: true });
};

// Admin Stats
exports.getAdminStats = async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Parallel Execution
        const [
            totalStudents,
            totalTeachers,
            attendanceToday,
            collectedFees,
            recentComplaints,
            activeYear
        ] = await Promise.all([
            User.countDocuments({ role: 'student' }),
            User.countDocuments({ role: 'teacher' }),
            Attendance.find({
                date: { $gte: today, $lt: tomorrow },
                role: 'student'
            }).lean(),
            FeePayment.aggregate([
                { $match: { status: 'success' } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            Complaint.find()
                .sort({ createdAt: -1 })
                .limit(5)
                .populate('student', 'name')
                .select('title status student createdAt')
                .lean(),
            getActiveYear()
        ]);

        const presentCount = attendanceToday.filter(a => a.status === 'present').length;
        const absentCount = attendanceToday.filter(a => a.status === 'absent').length;
        const attendancePercentage = attendanceToday.length > 0
            ? ((presentCount / attendanceToday.length) * 100).toFixed(1)
            : 0;

        const totalCollected = collectedFees.length > 0 ? collectedFees[0].total : 0;

        // Fee Trend Logic
        const feeMatchQuery = { status: 'success' };
        if (activeYear) {
            feeMatchQuery.paymentDate = {
                $gte: activeYear.startDate,
                $lte: activeYear.endDate
            };
        } else {
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            feeMatchQuery.paymentDate = { $gte: sixMonthsAgo };
        }

        const feeTrend = await FeePayment.aggregate([
            { $match: feeMatchQuery },
            {
                $group: {
                    _id: { $month: "$paymentDate" },
                    total: { $sum: "$amount" }
                }
            },
            { $sort: { "_id": 1 } }
        ]);

        res.json({
            overview: {
                totalStudents,
                totalTeachers,
                attendancePercentage,
                totalCollected
            },
            charts: {
                attendance: { present: presentCount, absent: absentCount },
                feeTrend: feeTrend.map(f => ({ month: f._id, amount: f.total }))
            },
            recentComplaints
        });

    } catch (error) {
        console.error('Admin Dashboard Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// Teacher Stats
exports.getTeacherStats = async (req, res) => {
    try {
        const teacherId = req.user.id; // Assignments logic needed if we link classes to teachers directly

        // Mocking class ID for now or fetching from Teacher's assigned subjects?
        // Assuming teacher is associated with subjects in User model: subjects: [{ type: ObjectId, ref: 'Subject' }]
        // A better approach would be finding Classes where this teacher teaches a Subject.

        // For now, let's get Stats for ALL students (if class teacher) or specific logic.
        // Let's assume we want to show stats for the teacher's "Main" class or just general teaching stats.

        // 1. My Classes Count (unique classes taught by this teacher)
        // Need to find Timetable or ClassContent where teacher is assigned? 
        // Or using Class model if it has 'classTeacher' field?
        // Let's check Class model next, but for now assuming generic stats.

        // 2. Low Attendance Students (Global for now, should be filtered by teacher's students)
        // Finding students with < 75% attendance in last 30 days
        const last30Days = new Date();
        last30Days.setDate(last30Days.getDate() - 30);

        // Complex aggregation, skipping for MVP stability, returning simple counts

        res.json({
            message: "Teacher stats implementation pending deeper class-teacher relation check",
            // Placeholder data structure
            overview: {
                classesToday: 4,
                pendingHomework: 12,
                lowAttendanceCount: 3
            },
            charts: {
                performance: { labels: ['Math', 'Sci', 'Eng'], data: [85, 78, 92] },
                attendanceWait: [90, 88, 92, 85]
            }
        });

    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// Student Stats
exports.getStudentStats = async (req, res) => {
    try {
        const studentId = req.user.id;

        const [
            totalDays,
            presentDays,
            pendingFees,
            recentMarks
        ] = await Promise.all([
            Attendance.countDocuments({ user: studentId, role: 'student' }),
            Attendance.countDocuments({ user: studentId, role: 'student', status: 'present' }),
            FeePayment.find({ student: studentId, status: 'pending' }).lean(),
            Marks.find({ student: studentId })
                .sort({ createdAt: -1 })
                .limit(10)
                .populate('exam', 'name')
                .populate({
                    path: 'exam',
                    populate: { path: 'subject', select: 'name' }
                })
                .lean()
        ]);

        // 1. Attendance %
        const attendancePercentage = totalDays > 0 ? ((presentDays / totalDays) * 100).toFixed(1) : 0;

        // 2. Fee Due
        const dueAmount = pendingFees.reduce((acc, curr) => acc + curr.amount, 0);

        // 3. Recent Marks Trend
        const performanceTrend = recentMarks.map(m => ({
            exam: m.exam?.name || 'Unknown',
            subject: m.exam?.subject?.name || 'Subject',
            marks: m.marksObtained,
            date: m.createdAt
        })).reverse();

        res.json({
            overview: {
                attendancePercentage,
                dueAmount,
                nextExamDate: "2025-01-10" // logic to find next exam from Exam model
            },
            charts: {
                performanceTrend
            }
        });

    } catch (error) {
        console.error('Student Dashboard Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};
