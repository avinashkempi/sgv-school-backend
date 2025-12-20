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
        // 1. Overview Counts
        const totalStudents = await User.countDocuments({ role: 'student' });
        const totalTeachers = await User.countDocuments({ role: 'teacher' });

        // 2. Today's Attendance
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const attendanceToday = await Attendance.find({
            date: { $gte: today, $lt: tomorrow },
            role: 'student'
        });

        const presentCount = attendanceToday.filter(a => a.status === 'present').length;
        const absentCount = attendanceToday.filter(a => a.status === 'absent').length;
        const attendancePercentage = attendanceToday.length > 0
            ? ((presentCount / attendanceToday.length) * 100).toFixed(1)
            : 0;

        // 3. Fee Stats (Simplified for now - pending vs collected)
        // This logic might need adjustment based on valid FeeStructure relation
        const collectedFees = await FeePayment.aggregate([
            { $match: { status: 'success' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const totalCollected = collectedFees.length > 0 ? collectedFees[0].total : 0;

        // 4. Recent Complaints
        const recentComplaints = await Complaint.find()
            .sort({ createdAt: -1 })
            .limit(5)
            .populate('student', 'name')
            .select('title status student createdAt');

        // 5. Fee Collection Trend (Current Academic Year)
        const activeYear = await getActiveYear();
        const feeMatchQuery = { status: 'success' };

        if (activeYear) {
            feeMatchQuery.paymentDate = {
                $gte: activeYear.startDate,
                $lte: activeYear.endDate
            };
        } else {
            // Fallback to last 6 months if no active year found
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

        // 1. Attendance %
        const totalDays = await Attendance.countDocuments({ user: studentId, role: 'student' });
        const presentDays = await Attendance.countDocuments({ user: studentId, role: 'student', status: 'present' });
        const attendancePercentage = totalDays > 0 ? ((presentDays / totalDays) * 100).toFixed(1) : 0;

        // 2. Fee Due
        // Simplified: check for any pending fee payments or logic link to FeeStructure
        // For now, returning hardcoded or simple query
        const pendingFees = await FeePayment.find({ student: studentId, status: 'pending' });
        const dueAmount = pendingFees.reduce((acc, curr) => acc + curr.amount, 0);

        // 3. Recent Marks (Current Academic Year)
        const activeYear = await getActiveYear();
        const marksQuery = { student: studentId };

        // If we want to filter by academic year, we'd ideally check if the Exam belongs to it.
        // For now, filtering by date if Exam has one, or just limit to recent ones as before but within year range.
        // Assuming exams are within the academic year.

        const recentMarks = await Marks.find(marksQuery)
            .sort({ createdAt: -1 })
            .limit(10) // Show more for academic year trend
            .populate('exam', 'name')
            .populate({
                path: 'exam',
                populate: { path: 'subject', select: 'name' }
            });

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
