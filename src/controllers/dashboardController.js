const User = require('../models/User');
const Attendance = require('../models/Attendance');
const FeePayment = require('../models/FeePayment');
const Complaint = require('../models/Complaint');
const Marks = require('../models/Marks');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const Exam = require('../models/Exam');
const AcademicYear = require('../models/AcademicYear');

// Helper to calculate date range
const getDateRange = (range) => {
    const now = new Date();
    let startDate, endDate = now;

    switch (range) {
        case 'today':
            startDate = new Date(now);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(now);
            endDate.setHours(23, 59, 59, 999);
            break;
        case 'thisWeek':
            const startOfWeek = now.getDate() - now.getDay();
            startDate = new Date(now.setDate(startOfWeek));
            startDate.setHours(0, 0, 0, 0);
            break;
        case 'last30Days':
            startDate = new Date(now);
            startDate.setDate(startDate.getDate() - 30);
            break;
        case 'thisYear':
            startDate = new Date(now.getFullYear(), 0, 1);
            break;
        case 'lastYear':
            startDate = new Date(now.getFullYear() - 1, 0, 1);
            endDate = new Date(now.getFullYear() - 1, 11, 31);
            break;
        case 'allTime':
            startDate = new Date(2020, 0, 1); // Or your school's founding date
            break;
        case 'thisMonth':
        default:
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
    }

    return { startDate, endDate };
};

// Admin Stats
exports.getAdminStats = async (req, res) => {
    try {
        const { range = 'thisMonth' } = req.query;
        const { startDate, endDate } = getDateRange(range);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Get previous period for trend calculation
        const periodDuration = endDate - startDate;
        const prevStartDate = new Date(startDate.getTime() - periodDuration);
        const prevEndDate = new Date(startDate);

        // Parallel Execution
        const [
            totalStudents,
            totalTeachers,
            attendanceToday,
            collectedFees,
            prevCollectedFees,
            prevAttendance,
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
                { $match: { status: 'success', paymentDate: { $gte: startDate, $lte: endDate } } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            FeePayment.aggregate([
                { $match: { status: 'success', paymentDate: { $gte: prevStartDate, $lt: prevEndDate } } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            Attendance.find({
                date: { $gte: prevStartDate, $lt: prevEndDate },
                role: 'student'
            }).lean(),
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

        // Calculate attendance trend
        const prevPresentCount = prevAttendance.filter(a => a.status === 'present').length;
        const prevAttendancePercentage = prevAttendance.length > 0
            ? ((prevPresentCount / prevAttendance.length) * 100)
            : 0;
        const attendanceTrend = (attendancePercentage - prevAttendancePercentage).toFixed(1);

        const totalCollected = collectedFees.length > 0 ? collectedFees[0].total : 0;
        const prevTotalCollected = prevCollectedFees.length > 0 ? prevCollectedFees[0].total : 0;
        const feeCollectionTrend = prevTotalCollected > 0
            ? (((totalCollected - prevTotalCollected) / prevTotalCollected) * 100).toFixed(1)
            : 0;

        // Fee Trend Logic
        const feeMatchQuery = { status: 'success', paymentDate: { $gte: startDate, $lte: endDate } };

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
                attendancePercentage: parseFloat(attendancePercentage),
                attendanceTrend: parseFloat(attendanceTrend),
                totalCollected,
                feeCollectionTrend: parseFloat(feeCollectionTrend)
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
        const { range = 'thisMonth' } = req.query;
        const { startDate, endDate } = getDateRange(range);

        // Get previous period for trend
        const periodDuration = endDate - startDate;
        const prevStartDate = new Date(startDate.getTime() - periodDuration);
        const prevEndDate = new Date(startDate);

        const [
            totalDays,
            presentDays,
            prevTotalDays,
            prevPresentDays,
            pendingFees,
            recentMarks,
            nextExam
        ] = await Promise.all([
            Attendance.countDocuments({
                user: studentId,
                role: 'student',
                date: { $gte: startDate, $lte: endDate }
            }),
            Attendance.countDocuments({
                user: studentId,
                role: 'student',
                status: 'present',
                date: { $gte: startDate, $lte: endDate }
            }),
            Attendance.countDocuments({
                user: studentId,
                role: 'student',
                date: { $gte: prevStartDate, $lt: prevEndDate }
            }),
            Attendance.countDocuments({
                user: studentId,
                role: 'student',
                status: 'present',
                date: { $gte: prevStartDate, $lt: prevEndDate }
            }),
            FeePayment.find({ student: studentId, status: 'pending' }).lean(),
            Marks.find({ student: studentId })
                .sort({ createdAt: -1 })
                .limit(10)
                .populate('exam', 'name')
                .populate({
                    path: 'exam',
                    populate: { path: 'subject', select: 'name' }
                })
                .lean(),
            Exam.findOne({ examDate: { $gte: new Date() } })
                .sort({ examDate: 1 })
                .select('examDate name')
                .lean()
        ]);

        // 1. Attendance %
        const attendancePercentage = totalDays > 0 ? ((presentDays / totalDays) * 100).toFixed(1) : 0;
        const prevAttendancePercentage = prevTotalDays > 0 ? ((prevPresentDays / prevTotalDays) * 100) : 0;
        const attendanceTrend = (attendancePercentage - prevAttendancePercentage).toFixed(1);

        // 2. Fee Due
        const dueAmount = pendingFees.reduce((acc, curr) => acc + curr.amount, 0);

        // 3. Recent Marks Trend
        const performanceTrend = recentMarks.map(m => ({
            exam: m.exam?.name || 'Unknown',
            subject: m.exam?.subject?.name || 'Subject',
            marks: m.marksObtained,
            date: m.createdAt
        })).reverse();

        // 4. Next Exam Date
        const nextExamDate = nextExam
            ? new Date(nextExam.examDate).toISOString().split('T')[0]
            : null;

        res.json({
            overview: {
                attendancePercentage: parseFloat(attendancePercentage),
                attendanceTrend: parseFloat(attendanceTrend),
                dueAmount,
                nextExamDate
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
