const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const Marks = require('../models/Marks');
const Exam = require('../models/Exam');
const GradeConfig = require('../models/GradeConfig');
const User = require('../models/User');

// Helper function to calculate grade
const calculateGrade = async (percentage, examId) => {
    try {
        const exam = await Exam.findById(examId).populate('academicYear');
        if (!exam || !exam.academicYear) {
            return getDefaultGrade(percentage);
        }

        const gradeConfig = await GradeConfig.findOne({ academicYear: exam.academicYear._id });
        if (!gradeConfig) {
            return getDefaultGrade(percentage);
        }

        const result = gradeConfig.getGrade(percentage);
        return result.grade;
    } catch (_error) {
        return getDefaultGrade(percentage);
    }
};

// Default grading system
const getDefaultGrade = (percentage) => {
    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 70) return 'B+';
    if (percentage >= 60) return 'B';
    if (percentage >= 50) return 'C';
    if (percentage >= 40) return 'D';
    return 'F';
};

// @route   POST /api/marks/bulk
// @desc    Enter marks for multiple students (bulk upload)
// @access  Private (Teacher)
router.post('/bulk', auth, async (req, res) => {
    try {
        const { examId, marksData } = req.body;
        // marksData = [{ studentId, marksObtained, remarks? }, ...]

        const exam = await Exam.findById(examId);
        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Validate teacher authorization
        const Subject = require('../models/Subject');
        const subject = await Subject.findById(exam.subject);
        if (!subject.teachers.includes(req.user.userId)) {
            return res.status(403).json({ message: 'Not authorized to enter marks for this exam' });
        }

        const results = [];

        for (const data of marksData) {
            const { studentId, marksObtained, remarks } = data;

            // Validate marks
            if (marksObtained < 0 || marksObtained > exam.totalMarks) {
                results.push({
                    studentId,
                    success: false,
                    error: `Marks must be between 0 and ${exam.totalMarks}`
                });
                continue;
            }

            const percentage = ((marksObtained / exam.totalMarks) * 100).toFixed(2);
            const grade = await calculateGrade(parseFloat(percentage), examId);

            try {
                // Check if marks already exist
                let marks = await Marks.findOne({ student: studentId, exam: examId });

                if (marks) {
                    // Update existing marks
                    marks.marksObtained = marksObtained;
                    marks.percentage = parseFloat(percentage);
                    marks.grade = grade;
                    marks.remarks = remarks || '';
                    marks.enteredBy = req.user.userId;
                    await marks.save();
                } else {
                    // Create new marks entry
                    marks = new Marks({
                        student: studentId,
                        exam: examId,
                        marksObtained,
                        percentage: parseFloat(percentage),
                        grade,
                        remarks: remarks || '',
                        enteredBy: req.user.userId
                    });
                    await marks.save();
                }

                results.push({
                    studentId,
                    success: true,
                    marks: marks
                });
            } catch (error) {
                results.push({
                    studentId,
                    success: false,
                    error: error.message
                });
            }
        }

        res.json({ message: 'Bulk marks entry completed', results });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/marks
// @desc    Enter/Update marks for a single student
// @access  Private (Teacher)
router.post('/', auth, async (req, res) => {
    try {
        const { examId, studentId, marksObtained, remarks } = req.body;

        const exam = await Exam.findById(examId);
        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Validate marks
        if (marksObtained < 0 || marksObtained > exam.totalMarks) {
            return res.status(400).json({ message: `Marks must be between 0 and ${exam.totalMarks}` });
        }

        // Validate teacher authorization
        const Subject = require('../models/Subject');
        const subject = await Subject.findById(exam.subject);
        if (!subject.teachers.includes(req.user.userId)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const percentage = ((marksObtained / exam.totalMarks) * 100).toFixed(2);
        const grade = await calculateGrade(parseFloat(percentage), examId);

        // Check if marks already exist
        let marks = await Marks.findOne({ student: studentId, exam: examId });

        if (marks) {
            // Update existing
            marks.marksObtained = marksObtained;
            marks.percentage = parseFloat(percentage);
            marks.grade = grade;
            marks.remarks = remarks || '';
            marks.enteredBy = req.user.userId;
            await marks.save();
        } else {
            // Create new
            marks = new Marks({
                student: studentId,
                exam: examId,
                marksObtained,
                percentage: parseFloat(percentage),
                grade,
                remarks: remarks || '',
                enteredBy: req.user.userId
            });
            await marks.save();
        }

        const populatedMarks = await Marks.findById(marks._id)
            .populate('student', 'name email')
            .populate('exam', 'name type totalMarks')
            .populate('enteredBy', 'name');

        res.json(populatedMarks);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/marks/exam/:examId
// @desc    Get all marks for an exam
// @access  Private (Teacher)
router.get('/exam/:examId', auth, async (req, res) => {
    try {
        const marks = await Marks.find({ exam: req.params.examId })
            .populate('student', 'name email')
            .populate('enteredBy', 'name')
            .sort({ marksObtained: -1 });

        res.json(marks);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/marks/student/:studentId
// @desc    Get all marks for a student
// @access  Private (Student/Teacher/Admin)
router.get('/student/:studentId', auth, async (req, res) => {
    try {
        const marks = await Marks.find({ student: req.params.studentId })
            .populate({
                path: 'exam',
                populate: [
                    { path: 'subject', select: 'name' },
                    { path: 'class', select: 'name section' }
                ]
            })
            .populate('enteredBy', 'name')
            .sort({ 'exam.date': -1 });

        res.json(marks);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/marks/student/:studentId/report-card
// @desc    Generate comprehensive report card for a student
// @access  Private
router.get('/student/:studentId/report-card', auth, async (req, res) => {
    try {
        const { academicYearId } = req.query;

        const student = await User.findById(req.params.studentId)
            .select('name email phone currentClass')
            .populate('currentClass', 'name section');

        if (!student) {
            return res.status(404).json({ message: 'Student not found' });
        }

        // Build query
        let query = { student: req.params.studentId };

        // Get marks with academic year filter if provided
        let marks;
        if (academicYearId) {
            const exams = await Exam.find({ academicYear: academicYearId });
            const examIds = exams.map(e => e._id);
            query.exam = { $in: examIds };
        }

        marks = await Marks.find(query)
            .populate({
                path: 'exam',
                populate: [
                    { path: 'subject', select: 'name' },
                    { path: 'class', select: 'name section' },
                    { path: 'academicYear', select: 'name' }
                ]
            });

        // Group by subject
        const subjectWise = {};
        let totalMarksObtained = 0;
        let totalMaxMarks = 0;

        marks.forEach(mark => {
            if (!mark.exam || !mark.exam.subject) return;

            const subjectId = mark.exam.subject._id.toString();
            const subjectName = mark.exam.subject.name;

            if (!subjectWise[subjectId]) {
                subjectWise[subjectId] = {
                    subjectId,
                    subjectName,
                    exams: [],
                    totalObtained: 0,
                    totalMax: 0,
                    percentage: 0
                };
            }

            subjectWise[subjectId].exams.push({
                examName: mark.exam.name,
                examType: mark.exam.type,
                marksObtained: mark.marksObtained,
                totalMarks: mark.exam.totalMarks,
                percentage: mark.percentage,
                grade: mark.grade,
                date: mark.exam.date
            });

            subjectWise[subjectId].totalObtained += mark.marksObtained;
            subjectWise[subjectId].totalMax += mark.exam.totalMarks;

            totalMarksObtained += mark.marksObtained;
            totalMaxMarks += mark.exam.totalMarks;
        });

        // Calculate subject percentages
        Object.keys(subjectWise).forEach(subjectId => {
            const subject = subjectWise[subjectId];
            subject.percentage = subject.totalMax > 0
                ? ((subject.totalObtained / subject.totalMax) * 100).toFixed(2)
                : 0;
            subject.grade = getDefaultGrade(parseFloat(subject.percentage));
        });

        // Overall percentage
        const overallPercentage = totalMaxMarks > 0
            ? ((totalMarksObtained / totalMaxMarks) * 100).toFixed(2)
            : 0;

        // Calculate class rank (if possible)
        let rank = null;
        if (student.currentClass) {
            const classStudents = await User.find({
                currentClass: student.currentClass._id,
                role: 'student'
            });

            const studentPercentages = await Promise.all(
                classStudents.map(async (s) => {
                    const sMarks = await Marks.find({ student: s._id })
                        .populate('exam', 'totalMarks academicYear');

                    let sTotal = 0;
                    let sMax = 0;

                    sMarks.forEach(m => {
                        if (!academicYearId || m.exam.academicYear?.toString() === academicYearId) {
                            sTotal += m.marksObtained;
                            sMax += m.exam.totalMarks;
                        }
                    });

                    const sPercentage = sMax > 0 ? (sTotal / sMax) * 100 : 0;
                    return { studentId: s._id.toString(), percentage: sPercentage };
                })
            );

            studentPercentages.sort((a, b) => b.percentage - a.percentage);
            rank = studentPercentages.findIndex(sp => sp.studentId === req.params.studentId) + 1;
        }

        res.json({
            student: {
                _id: student._id,
                name: student.name,
                email: student.email,
                phone: student.phone,
                class: student.currentClass
            },
            subjectWise: Object.values(subjectWise),
            overall: {
                totalMarksObtained,
                totalMaxMarks,
                percentage: parseFloat(overallPercentage),
                grade: getDefaultGrade(parseFloat(overallPercentage)),
                rank
            }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/marks/:id
// @desc    Delete marks entry
// @access  Private (Teacher - who entered OR Admin)
router.delete('/:id', auth, async (req, res) => {
    try {
        const marks = await Marks.findById(req.params.id);

        if (!marks) {
            return res.status(404).json({ message: 'Marks not found' });
        }

        const user = await User.findById(req.user.userId);

        // Check authorization
        if (marks.enteredBy.toString() !== req.user.userId && user.role !== 'admin' && user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        await Marks.findByIdAndDelete(req.params.id);

        res.json({ message: 'Marks deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
