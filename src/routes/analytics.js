const express = require('express');
const router = express.Router();
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const Marks = require('../models/Marks');
const User = require('../models/User');
const Class = require('../models/Class');
const Exam = require('../models/Exam');
const Subject = require('../models/Subject');
const Attendance = require('../models/Attendance');
const FeePayment = require('../models/FeePayment');

// @route   GET /api/analytics/student/:studentId/report-card
// @desc    Generate comprehensive report card data for a student
// @access  Private
router.get('/student/:studentId/report-card', auth, async (req, res) => {
    try {
        const { studentId } = req.params;
        const { examId } = req.query;

        const student = await User.findById(studentId)
            .populate('currentClass', 'name section')
            .populate('academicYear', 'name')
            .lean();

        if (!student) {
            return res.status(404).json({ success: false, message: 'Student not found' });
        }

        // Get marks for the exam
        const marks = await Marks.find({
            student: studentId,
            exam: examId
        })
            .populate('exam', 'name totalMarks')
            .populate({
                path: 'exam',
                populate: { path: 'subject', select: 'name' }
            })
            .lean();

        // Calculate subject-wise performance
        const subjects = marks.map(m => ({
            subject: m.exam?.subject?.name || 'Unknown',
            marksObtained: m.marksObtained,
            totalMarks: m.exam?.totalMarks || 100,
            percentage: m.exam?.totalMarks ? ((m.marksObtained / m.exam.totalMarks) * 100).toFixed(1) : 0,
            grade: calculateGrade((m.marksObtained / (m.exam?.totalMarks || 100)) * 100),
            remarks: m.remarks || ''
        }));

        // Calculate overall statistics
        const totalMarksObtained = subjects.reduce((sum, s) => sum + s.marksObtained, 0);
        const totalMaxMarks = subjects.reduce((sum, s) => sum + s.totalMarks, 0);
        const overallPercentage = totalMaxMarks > 0 ? ((totalMarksObtained / totalMaxMarks) * 100).toFixed(2) : 0;
        const overallGrade = calculateGrade(overallPercentage);

        // Get attendance for the academic year
        const attendanceRecords = await Attendance.find({
            user: studentId,
            date: { $gte: student.academicYear?.startDate || new Date() }
        }).lean();

        const totalDays = attendanceRecords.length;
        const presentDays = attendanceRecords.filter(a => ['present', 'late', 'excused'].includes(a.status)).length;
        const attendancePercentage = totalDays > 0 ? ((presentDays / totalDays) * 100).toFixed(1) : 0;

        // Get class rank (if applicable)
        const classStudents = await User.find({
            currentClass: student.currentClass._id,
            role: 'student'
        }).select('_id').lean();

        let rank = null;
        if (examId) {
            const allStudentMarks = await Promise.all(
                classStudents.map(async (s) => {
                    const studentMarks = await Marks.find({
                        student: s._id,
                        exam: examId
                    }).lean();

                    const total = studentMarks.reduce((sum, m) => sum + m.marksObtained, 0);
                    return { studentId: s._id, total };
                })
            );

            allStudentMarks.sort((a, b) => b.total - a.total);
            const studentRankIndex = allStudentMarks.findIndex(s => s.studentId.toString() === studentId);
            rank = studentRankIndex >= 0 ? studentRankIndex + 1 : null;
        }

        res.json({
            success: true,
            reportCard: {
                student: {
                    name: student.name,
                    class: student.currentClass,
                    academicYear: student.academicYear,
                    rollNumber: student.rollNumber || '-'
                },
                performance: {
                    subjects,
                    totalMarksObtained,
                    totalMaxMarks,
                    overallPercentage: parseFloat(overallPercentage),
                    overallGrade,
                    rank,
                    totalStudents: classStudents.length
                },
                attendance: {
                    totalDays,
                    presentDays,
                    absentDays: totalDays - presentDays,
                    percentage: parseFloat(attendancePercentage)
                },
                generatedAt: new Date()
            }
        });
    } catch (err) {
        console.error('Report Card Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/analytics/class/:classId/performance
// @desc    Get class performance analytics
// @access  Private (Teacher/Admin)
router.get('/class/:classId/performance', auth, async (req, res) => {
    try {
        const { classId } = req.params;
        const { examId } = req.query;

        const students = await User.find({
            currentClass: classId,
            role: 'student'
        }).lean();

        const performanceData = await Promise.all(
            students.map(async (student) => {
                const marks = await Marks.find({
                    student: student._id,
                    exam: examId
                }).populate('exam', 'totalMarks').lean();

                const totalObtained = marks.reduce((sum, m) => sum + m.marksObtained, 0);
                const totalMax = marks.reduce((sum, m) => sum + (m.exam?.totalMarks || 0), 0);
                const percentage = totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(1) : 0;

                return {
                    student: {
                        _id: student._id,
                        name: student.name
                    },
                    totalObtained,
                    totalMax,
                    percentage: parseFloat(percentage),
                    grade: calculateGrade(percentage)
                };
            })
        );

        // Sort by percentage (descending)
        performanceData.sort((a, b) => b.percentage - a.percentage);

        // Calculate statistics
        const percentages = performanceData.map(p => p.percentage);
        const average = percentages.length > 0
            ? (percentages.reduce((sum, p) => sum + p, 0) / percentages.length).toFixed(1)
            : 0;
        const highest = Math.max(...percentages, 0);
        const lowest = Math.min(...percentages, 100);

        // Grade distribution
        const gradeDistribution = {
            'A+': performanceData.filter(p => p.grade === 'A+').length,
            'A': performanceData.filter(p => p.grade === 'A').length,
            'B': performanceData.filter(p => p.grade === 'B').length,
            'C': performanceData.filter(p => p.grade === 'C').length,
            'D': performanceData.filter(p => p.grade === 'D').length,
            'F': performanceData.filter(p => p.grade === 'F').length
        };

        res.json({
            success: true,
            analytics: {
                totalStudents: students.length,
                statistics: {
                    average: parseFloat(average),
                    highest,
                    lowest
                },
                gradeDistribution,
                topPerformers: performanceData.slice(0, 10),
                performanceData
            }
        });
    } catch (err) {
        console.error('Class Performance Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/analytics/subject/:subjectId/analysis
// @desc    Get subject-wise performance analysis
// @access  Private (Teacher/Admin)
router.get('/subject/:subjectId/analysis', auth, async (req, res) => {
    try {
        const { subjectId } = req.params;

        const subject = await Subject.findById(subjectId).lean();
        if (!subject) {
            return res.status(404).json({ success: false, message: 'Subject not found' });
        }

        // Get all exams for this subject
        const exams = await Exam.find({ subject: subjectId }).lean();

        const analysis = await Promise.all(
            exams.map(async (exam) => {
                const marks = await Marks.find({ exam: exam._id }).lean();

                const scores = marks.map(m => m.marksObtained);
                const average = scores.length > 0
                    ? (scores.reduce((sum, s) => sum + s, 0) / scores.length).toFixed(1)
                    : 0;

                return {
                    exam: {
                        _id: exam._id,
                        name: exam.name,
                        date: exam.examDate,
                        totalMarks: exam.totalMarks
                    },
                    statistics: {
                        studentsAppeared: marks.length,
                        average: parseFloat(average),
                        highest: Math.max(...scores, 0),
                        lowest: Math.min(...scores, exam.totalMarks),
                        passPercentage: marks.length > 0
                            ? ((marks.filter(m => (m.marksObtained / exam.totalMarks) * 100 >= 40).length / marks.length) * 100).toFixed(1)
                            : 0
                    }
                };
            })
        );

        res.json({
            success: true,
            subject: {
                _id: subject._id,
                name: subject.name
            },
            analysis
        });
    } catch (err) {
        console.error('Subject Analysis Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/analytics/school/overview
// @desc    Get school-wide analytics overview
// @access  Admin/Super Admin
router.get('/school/overview', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const [
            totalStudents,
            totalTeachers,
            totalClasses,
            todayAttendance,
            totalFeeCollected,
            pendingExams
        ] = await Promise.all([
            User.countDocuments({ role: 'student' }),
            User.countDocuments({ role: 'teacher' }),
            Class.countDocuments(),
            Attendance.countDocuments({
                date: {
                    $gte: new Date().setHours(0, 0, 0, 0),
                    $lt: new Date().setHours(23, 59, 59, 999)
                },
                status: 'present'
            }),
            FeePayment.aggregate([
                { $match: { status: 'success' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            Exam.countDocuments({
                examDate: { $gte: new Date() }
            })
        ]);

        res.json({
            success: true,
            overview: {
                students: {
                    total: totalStudents,
                    presentToday: todayAttendance
                },
                teachers: {
                    total: totalTeachers
                },
                classes: {
                    total: totalClasses
                },
                fees: {
                    totalCollected: totalFeeCollected[0]?.total || 0
                },
                exams: {
                    upcoming: pendingExams
                }
            }
        });
    } catch (err) {
        console.error('School Overview Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/analytics/trends/performance
// @desc    Get performance trends over time
// @access  Private
router.get('/trends/performance', auth, async (req, res) => {
    try {
        const { classId, subjectId, period = 'monthly' } = req.query;

        const matchQuery = {};
        if (classId) {
            const students = await User.find({ currentClass: classId, role: 'student' }).select('_id');
            matchQuery.student = { $in: students.map(s => s._id) };
        }

        const marks = await Marks.find(matchQuery)
            .populate('exam', 'name examDate totalMarks subject')
            .lean();

        // Filter by subject if specified
        const filteredMarks = subjectId
            ? marks.filter(m => m.exam?.subject?.toString() === subjectId)
            : marks;

        // Group by period
        const trends = {};
        filteredMarks.forEach(mark => {
            if (!mark.exam?.examDate) return;

            const date = new Date(mark.exam.examDate);
            let key;

            if (period === 'weekly') {
                const weekNum = Math.ceil(date.getDate() / 7);
                key = `${date.getFullYear()}-${date.getMonth() + 1}-W${weekNum}`;
            } else if (period === 'monthly') {
                key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
            } else {
                key = date.getFullYear().toString();
            }

            if (!trends[key]) {
                trends[key] = { period: key, total: 0, count: 0, marks: [] };
            }

            const percentage = (mark.marksObtained / mark.exam.totalMarks) * 100;
            trends[key].total += percentage;
            trends[key].count++;
            trends[key].marks.push(percentage);
        });

        const trendData = Object.values(trends).map(t => ({
            period: t.period,
            average: (t.total / t.count).toFixed(1),
            count: t.count
        })).sort((a, b) => a.period.localeCompare(b.period));

        res.json({
            success: true,
            trends: trendData,
            period
        });
    } catch (err) {
        console.error('Performance Trends Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// Helper function for grade calculation
function calculateGrade(percentage) {
    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 70) return 'B';
    if (percentage >= 60) return 'C';
    if (percentage >= 40) return 'D';
    return 'F';
}

module.exports = router;
