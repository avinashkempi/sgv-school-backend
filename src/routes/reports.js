const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const User = require('../models/User');
const _GradeConfig = require('../models/GradeConfig');

// Helper to get grade
const getGrade = (percentage) => {
    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 70) return 'B+';
    if (percentage >= 60) return 'B';
    if (percentage >= 50) return 'C';
    if (percentage >= 40) return 'D';
    return 'F';
};

// @route   GET /api/reports/student/:studentId
// @desc    Get standardized report card (FA1...SA2 structure)
// @access  Private
router.get('/student/:studentId', auth, async (req, res) => {
    try {
        const { academicYearId } = req.query;
        const studentId = req.params.studentId;

        // Validate access
        if (req.user.role === 'student' && req.user.userId !== studentId) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const student = await User.findById(studentId)
            .select('name email currentClass')
            .populate('currentClass', 'name section');

        if (!student) {
            return res.status(404).json({ message: 'Student not found' });
        }

        // Get Academic Year
        let yearId = academicYearId;
        if (!yearId) {
            const AcademicYear = require('../models/AcademicYear');
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }

        // Fetch all standardized exams for this class & year
        const exams = await Exam.find({
            class: student.currentClass._id,
            academicYear: yearId,
            isStandardized: true
        }).populate('subject', 'name');

        // Fetch all marks for this student
        const marks = await Marks.find({
            student: studentId,
            exam: { $in: exams.map(e => e._id) }
        });

        // Structure data by Exam Type (FA1, FA2...)
        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const reportData = examTypes.map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);

            let totalMax = 0;
            let totalObtained = 0;
            const subjects = typeExams.map(exam => {
                const markEntry = marks.find(m => m.exam.toString() === exam._id.toString());
                const obtained = markEntry ? markEntry.marksObtained : 0;
                const max = exam.totalMarks;

                totalMax += max;
                if (markEntry) totalObtained += obtained;

                return {
                    subject: exam.subject.name,
                    subjectId: exam.subject._id,
                    maxMarks: max,
                    obtainedMarks: markEntry ? obtained : null, // null means not entered/absent
                    percentage: markEntry ? ((obtained / max) * 100).toFixed(1) : null,
                    grade: markEntry ? getGrade((obtained / max) * 100) : '-'
                };
            });

            const percentage = totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(1) : 0;

            return {
                examType: type,
                isCompleted: typeExams.length > 0 && subjects.every(s => s.obtainedMarks !== null),
                totalMax,
                totalObtained,
                percentage,
                grade: getGrade(percentage),
                subjects
            };
        });

        // Calculate Overall Performance
        let grandTotalMax = 0;
        let grandTotalObtained = 0;
        reportData.forEach(r => {
            if (r.isCompleted) {
                grandTotalMax += r.totalMax;
                grandTotalObtained += r.totalObtained;
            }
        });

        const overallPercentage = grandTotalMax > 0 ? ((grandTotalObtained / grandTotalMax) * 100).toFixed(1) : 0;

        res.json({
            student: {
                name: student.name,
                class: student.currentClass.name + ' ' + student.currentClass.section
            },
            exams: reportData,
            overall: {
                percentage: overallPercentage,
                grade: getGrade(overallPercentage)
            }
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/reports/insights/:studentId
// @desc    Get performance trends
// @access  Private
router.get('/insights/:studentId', auth, async (req, res) => {
    try {
        // Re-use logic or simplify for just charts
        // For now, let's return subject-wise trends across exams

        const { academicYearId } = req.query;
        const studentId = req.params.studentId;

        // Get Academic Year
        let yearId = academicYearId;
        if (!yearId) {
            const AcademicYear = require('../models/AcademicYear');
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }

        const student = await User.findById(studentId);
        if (!student || !student.currentClass) {
            return res.status(404).json({ message: 'Student or class not found' });
        }

        const exams = await Exam.find({
            class: student.currentClass,
            academicYear: yearId,
            isStandardized: true
        }).populate('subject', 'name').sort({ date: 1 });

        const marks = await Marks.find({
            student: studentId,
            exam: { $in: exams.map(e => e._id) }
        });

        // Group by Subject
        const subjectTrends = {};

        exams.forEach(exam => {
            const subjectName = exam.subject.name;
            if (!subjectTrends[subjectName]) {
                subjectTrends[subjectName] = [];
            }

            const mark = marks.find(m => m.exam.toString() === exam._id.toString());
            if (mark) {
                subjectTrends[subjectName].push({
                    exam: exam.standardizedType,
                    percentage: mark.percentage
                });
            }
        });

        // Exam-wise comparison (FA1 vs FA2 etc)
        const examTrends = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'].map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);
            let totalMax = 0;
            let totalObtained = 0;

            typeExams.forEach(exam => {
                const mark = marks.find(m => m.exam.toString() === exam._id.toString());
                if (mark) {
                    totalMax += exam.totalMarks;
                    totalObtained += mark.marksObtained;
                }
            });

            return {
                exam: type,
                percentage: totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(1) : 0
            };
        });

        res.json({
            subjectTrends,
            examTrends
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
