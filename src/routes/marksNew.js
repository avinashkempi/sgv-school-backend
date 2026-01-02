// NEW MARKS ROUTES TO BE ADDED TO marks.js

const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const Marks = require('../models/Marks');
const Exam = require('../models/Exam');
const User = require('../models/User');
const Subject = require('../models/Subject');

// @route   POST /api/marks/grid-update
// @desc    Accept grid/spreadsheet-like data structure for rapid entry
// @access  Private (Teacher)
router.post('/grid-update', auth, async (req, res) => {
    try {
        const { examId, gridData } = req.body;
        // gridData: [{ studentId, marksObtained, remarks? }, ...]

        const exam = await Exam.findById(examId).populate('subject');
        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Validate teacher authorization
        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        if (!isAdmin && !exam.subject.teachers.includes(req.user.userId)) {
            return res.status(403).json({ message: 'Not authorized to enter marks for this exam' });
        }

        const results = {
            updated: 0,
            created: 0,
            errors: [],
            success: true
        };

        // Process all updates in bulk
        for (const row of gridData) {
            const { studentId, marksObtained, remarks } = row;

            // Skip empty rows
            if (marksObtained === null || marksObtained === undefined || marksObtained === '') {
                continue;
            }

            // Validate marks
            const marks = parseFloat(marksObtained);
            if (isNaN(marks) || marks < 0 || marks > exam.totalMarks) {
                results.errors.push({
                    studentId,
                    error: `Invalid marks: must be between 0 and ${exam.totalMarks}`
                });
                continue;
            }

            const percentage = ((marks / exam.totalMarks) * 100).toFixed(2);

            // Use default grading for now (can be enhanced later)
            const grade = getDefaultGrade(parseFloat(percentage));

            try {
                // Check if marks already exist
                let markEntry = await Marks.findOne({ student: studentId, exam: examId });

                if (markEntry) {
                    // Update existing
                    markEntry.marksObtained = marks;
                    markEntry.percentage = parseFloat(percentage);
                    markEntry.grade = grade;
                    markEntry.remarks = remarks || markEntry.remarks;
                    markEntry.enteredBy = req.user.userId;
                    await markEntry.save();
                    results.updated++;
                } else {
                    // Create new
                    markEntry = new Marks({
                        student: studentId,
                        exam: examId,
                        marksObtained: marks,
                        percentage: parseFloat(percentage),
                        grade,
                        remarks: remarks || '',
                        enteredBy: req.user.userId
                    });
                    await markEntry.save();
                    results.created++;
                }
            } catch (error) {
                results.errors.push({
                    studentId,
                    error: error.message
                });
            }
        }

        results.success = results.errors.length === 0;

        res.json({
            message: 'Grid update completed',
            ...results
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Helper function
function getDefaultGrade(percentage) {
    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 70) return 'B+';
    if (percentage >= 60) return 'B';
    if (percentage >= 50) return 'C';
    if (percentage >= 40) return 'D';
    return 'F';
}

// @route   GET /api/marks/exam/:examId/status
// @desc    Get marks entry completion status
// @access  Private (Teacher)
router.get('/exam/:examId/status', auth, async (req, res) => {
    try {
        const exam = await Exam.findById(req.params.examId).populate('class');
        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Get total students in class
        const totalStudents = await User.countDocuments({
            currentClass: exam.class._id,
            role: 'student'
        });

        // Get marks entered count
        const marksEntered = await Marks.countDocuments({
            exam: req.params.examId
        });

        // Get marks list with student info
        const marks = await Marks.find({ exam: req.params.examId })
            .populate('student', 'name');

        const enteredStudentIds = marks.map(m => m.student._id.toString());

        // Get pending students
        const allStudents = await User.find({
            currentClass: exam.class._id,
            role: 'student'
        }).select('_id name');

        const pendingStudents = allStudents.filter(
            s => !enteredStudentIds.includes(s._id.toString())
        );

        // Calculate statistics from entered marks
        let total = 0;
        let highest = 0;
        let lowest = 100;

        marks.forEach(m => {
            total += m.percentage;
            if (m.percentage > highest) highest = m.percentage;
            if (m.percentage < lowest) lowest = m.percentage;
        });

        const average = marksEntered > 0 ? (total / marksEntered).toFixed(2) : 0;

        res.json({
            examId: req.params.examId,
            examName: exam.name,
            totalStudents,
            marksEntered,
            pending: totalStudents - marksEntered,
            percentageComplete: totalStudents > 0 ? ((marksEntered / totalStudents) * 100).toFixed(2) : 0,
            pendingStudents,
            statistics: {
                average: parseFloat(average),
                highest,
                lowest: marksEntered > 0 ? lowest : 0
            }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/marks/class/:classId/summary
// @desc    Class-wise marks summary across all exams
// @access  Private (Teacher/Admin)
router.get('/class/:classId/summary', auth, async (req, res) => {
    try {
        const { academicYearId } = req.query;

        // Get active academic year if not provided
        let yearId = academicYearId;
        if (!yearId) {
            const AcademicYear = require('../models/AcademicYear');
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }

        // Get all exams for this class
        const exams = await Exam.find({
            class: req.params.classId,
            academicYear: yearId,
            isStandardized: true
        }).populate('subject', 'name');

        // Get all students in class
        const students = await User.find({
            currentClass: req.params.classId,
            role: 'student'
        }).select('name email');

        // Get all marks for these exams
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({
            exam: { $in: examIds }
        }).populate('student', 'name');

        // Group by exam type
        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const summary = examTypes.map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);
            const typeExamIds = typeExams.map(e => e._id.toString());
            const typeMarks = allMarks.filter(m => typeExamIds.includes(m.exam.toString()));

            let totalObtained = 0;
            let totalMax = 0;

            typeMarks.forEach(mark => {
                const exam = typeExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalObtained += mark.marksObtained;
                    totalMax += exam.totalMarks;
                }
            });

            const avgPercentage = totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(2) : 0;

            return {
                examType: type,
                examsCount: typeExams.length,
                marksEntered: typeMarks.length,
                expectedMarks: typeExams.length * students.length,
                avgPercentage: parseFloat(avgPercentage)
            };
        });

        res.json({
            classId: req.params.classId,
            totalStudents: students.length,
            totalExams: exams.length,
            summary
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/marks/bulk-grade
// @desc    Bulk update grades/remarks
// @access  Private (Teacher/Admin)
router.put('/bulk-grade', auth, async (req, res) => {
    try {
        const { marksIds, updates } = req.body;
        // updates: { grade?, remarks? }

        if (!marksIds || !Array.isArray(marksIds) || marksIds.length === 0) {
            return res.status(400).json({ message: 'Marks IDs array is required' });
        }

        // Verify authorization
        const marks = await Marks.find({ _id: { $in: marksIds } })
            .populate({
                path: 'exam',
                populate: { path: 'subject' }
            });

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        for (const mark of marks) {
            if (!isAdmin) {
                const subject = mark.exam.subject;
                if (!subject || !subject.teachers.includes(req.user.userId)) {
                    return res.status(403).json({
                        message: 'Not authorized to update these marks'
                    });
                }
            }
        }

        // Perform bulk update
        const updateData = {};
        if (updates.grade) updateData.grade = updates.grade;
        if (updates.remarks !== undefined) updateData.remarks = updates.remarks;
        updateData.enteredBy = req.user.userId;

        const result = await Marks.updateMany(
            { _id: { $in: marksIds } },
            { $set: updateData }
        );

        res.json({
            message: 'Bulk grade update completed',
            modifiedCount: result.modifiedCount
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/marks/analytics/class/:classId
// @desc    Detailed class analytics with student rankings
// @access  Private (Teacher/Admin)
router.get('/analytics/class/:classId', auth, async (req, res) => {
    try {
        const { academicYearId, examType } = req.query;

        // Get active academic year if not provided
        let yearId = academicYearId;
        if (!yearId) {
            const AcademicYear = require('../models/AcademicYear');
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }

        // Build exam query
        let examQuery = {
            class: req.params.classId,
            academicYear: yearId,
            isStandardized: true
        };

        if (examType) {
            examQuery.standardizedType = examType;
        }

        // Get exams
        const exams = await Exam.find(examQuery).populate('subject', 'name');

        // Get all students
        const students = await User.find({
            currentClass: req.params.classId,
            role: 'student'
        }).select('name email');

        // Get all marks
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({
            exam: { $in: examIds }
        }).populate('student', 'name');

        // Calculate student rankings
        const studentPerformance = students.map(student => {
            const studentMarks = allMarks.filter(
                m => m.student._id.toString() === student._id.toString()
            );

            let totalObtained = 0;
            let totalMax = 0;

            studentMarks.forEach(mark => {
                const exam = exams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalObtained += mark.marksObtained;
                    totalMax += exam.totalMarks;
                }
            });

            const percentage = totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(2) : 0;

            return {
                studentId: student._id,
                studentName: student.name,
                email: student.email,
                totalObtained,
                totalMax,
                percentage: parseFloat(percentage),
                grade: getDefaultGrade(parseFloat(percentage)),
                examsAttempted: studentMarks.length
            };
        });

        // Sort by percentage descending
        studentPerformance.sort((a, b) => b.percentage - a.percentage);

        // Add ranks
        studentPerformance.forEach((student, index) => {
            student.rank = index + 1;
        });

        // Grade distribution
        const gradeDistribution = {
            'A+': 0,
            'A': 0,
            'B+': 0,
            'B': 0,
            'C': 0,
            'D': 0,
            'F': 0
        };

        studentPerformance.forEach(student => {
            if (gradeDistribution[student.grade] !== undefined) {
                gradeDistribution[student.grade]++;
            }
        });

        // Calculate class statistics
        const totalPercentage = studentPerformance.reduce((sum, s) => sum + s.percentage, 0);
        const avgPercentage = students.length > 0 ? (totalPercentage / students.length).toFixed(2) : 0;
        const highest = studentPerformance.length > 0 ? studentPerformance[0].percentage : 0;
        const lowest = studentPerformance.length > 0 ? studentPerformance[studentPerformance.length - 1].percentage : 0;

        res.json({
            classId: req.params.classId,
            totalStudents: students.length,
            totalExams: exams.length,
            statistics: {
                average: parseFloat(avgPercentage),
                highest,
                lowest,
                median: studentPerformance.length > 0
                    ? studentPerformance[Math.floor(studentPerformance.length / 2)].percentage
                    : 0
            },
            gradeDistribution,
            studentRankings: studentPerformance
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/marks/export/class/:classId
// @desc    Export class marks as CSV/JSON
// @access  Private (Teacher/Admin)
router.get('/export/class/:classId', auth, async (req, res) => {
    try {
        const { format = 'json', academicYearId } = req.query;

        // Get active academic year if not provided
        let yearId = academicYearId;
        if (!yearId) {
            const AcademicYear = require('../models/AcademicYear');
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }

        // Get all exams
        const exams = await Exam.find({
            class: req.params.classId,
            academicYear: yearId,
            isStandardized: true
        }).populate('subject', 'name').sort({ standardizedType: 1 });

        // Get all students
        const students = await User.find({
            currentClass: req.params.classId,
            role: 'student'
        }).select('name email').sort({ name: 1 });

        // Get all marks
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({
            exam: { $in: examIds }
        });

        // Build export data
        const exportData = students.map(student => {
            const studentData = {
                studentName: student.name,
                email: student.email
            };

            // Add marks for each exam
            exams.forEach(exam => {
                const mark = allMarks.find(
                    m => m.student.toString() === student._id.toString() &&
                        m.exam.toString() === exam._id.toString()
                );

                const examKey = `${exam.standardizedType}_${exam.subject.name}`;
                studentData[examKey] = mark ? mark.marksObtained : '-';
                studentData[`${examKey}_Grade`] = mark ? mark.grade : '-';
            });

            return studentData;
        });

        if (format === 'csv') {
            // Convert to CSV
            if (exportData.length === 0) {
                return res.status(404).json({ message: 'No data to export' });
            }

            const headers = Object.keys(exportData[0]).join(',');
            const rows = exportData.map(row =>
                Object.values(row).map(val => `"${val}"`).join(',')
            );

            const csv = [headers, ...rows].join('\n');

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="class_marks_${req.params.classId}.csv"`);
            res.send(csv);
        } else {
            // Return JSON
            res.json({
                classId: req.params.classId,
                exportDate: new Date(),
                data: exportData
            });
        }
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
