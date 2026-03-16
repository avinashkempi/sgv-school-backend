const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const Marks = require('../models/Marks');
const Exam = require('../models/Exam');
const GradeConfig = require('../models/GradeConfig');
const User = require('../models/User');
const notificationController = require('../controllers/notificationController');

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

        const exam = await Exam.findById(examId).populate('class', 'classTeacher');
        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Validate teacher authorization
        const Subject = require('../models/Subject');
        const subject = await Subject.findById(exam.subject);

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isSubjectTeacher = subject && subject.teachers.includes(req.user.userId);
        const isClassTeacher = exam.class && exam.class.classTeacher && exam.class.classTeacher.toString() === req.user.userId.toString();

        if (!isAdmin && !isSubjectTeacher && !isClassTeacher) {
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

                // Trigger Notification for Student
                notificationController.triggerNotification({
                    title: 'New Marks Posted',
                    message: `Marks for ${exam.name} have been updated.`,
                    type: 'Exam',
                    target: 'user',
                    targetId: studentId,
                    metadata: { examId: exam._id, marksId: marks._id }
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

// @route   POST /api/marks/grid-update
// @desc    Update marks from grid view
// @access  Private (Teacher)
router.post('/grid-update', auth, async (req, res) => {
    try {
        const { examId, gridData } = req.body;
        // gridData = [{ studentId, marksObtained, remarks? }, ...]

        const exam = await Exam.findById(examId).populate('class', 'classTeacher');
        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Validate teacher authorization
        const Subject = require('../models/Subject');
        const subject = await Subject.findById(exam.subject);

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isSubjectTeacher = subject && subject.teachers.includes(req.user.userId);
        const isClassTeacher = exam.class && exam.class.classTeacher && exam.class.classTeacher.toString() === req.user.userId.toString();

        if (!isAdmin && !isSubjectTeacher && !isClassTeacher) {
            return res.status(403).json({ message: 'Not authorized to enter marks for this exam' });
        }

        let updated = 0;
        let created = 0;
        let errors = [];

        for (const data of gridData) {
            const { studentId, marksObtained, remarks } = data;

            // Validate marks
            if (marksObtained < 0 || marksObtained > exam.totalMarks) {
                errors.push({
                    studentId,
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
                    updated++;
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
                    created++;
                }
            } catch (error) {
                errors.push({ studentId, error: error.message });
            }
        }

        res.json({ message: 'Grid marks update completed', updated, created, errors });
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

        const exam = await Exam.findById(examId).populate('class', 'classTeacher');
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

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isSubjectTeacher = subject && subject.teachers.includes(req.user.userId);
        const isClassTeacher = exam.class && exam.class.classTeacher && exam.class.classTeacher.toString() === req.user.userId.toString();

        if (!isAdmin && !isSubjectTeacher && !isClassTeacher) {
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

        // Trigger Notification for Student
        notificationController.triggerNotification({
            title: 'New Marks Posted',
            message: `Marks for ${exam.name} have been updated.`,
            type: 'Exam',
            target: 'user',
            targetId: studentId,
            metadata: { examId: exam._id, marksId: marks._id }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/marks/exam/:examId/status
// @desc    Get marks entry status for an exam
// @access  Private (Teacher)
router.get('/exam/:examId/status', auth, async (req, res) => {
    try {
        const examId = req.params.examId;
        const exam = await Exam.findById(examId);

        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Get total students in the class
        const studentsCount = await User.countDocuments({
            role: 'student',
            currentClass: exam.class
        });

        // Get entered marks count
        const marksEntered = await Marks.countDocuments({ exam: examId });

        res.json({
            totalStudents: studentsCount,
            marksEntered: marksEntered,
            pending: studentsCount - marksEntered
        });
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
        // Students should not see all marks for an exam — only their own via /student/:id
        if (req.user.role === 'student') {
            return res.status(403).json({ message: 'Not authorized to view all marks for an exam' });
        }

        const marks = await Marks.find({ exam: req.params.examId })
            .populate('student', 'name email')
            .populate('enteredBy', 'name')
            .sort({ marksObtained: -1 })
            .lean();

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
        // Role-based access: students can only view their own marks
        if (req.user.role === 'student' && req.user.userId !== req.params.studentId) {
            return res.status(403).json({ message: 'Not authorized to view another student\'s marks' });
        }

        const marks = await Marks.find({ student: req.params.studentId })
            .populate({
                path: 'exam',
                populate: [
                    { path: 'subject', select: 'name' },
                    { path: 'class', select: 'name section' }
                ]
            })
            .populate('enteredBy', 'name')
            .sort({ 'exam.date': -1 })
            .lean();

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
        // Role-based access: students can only view their own report card
        if (req.user.role === 'student' && req.user.userId !== req.params.studentId) {
            return res.status(403).json({ message: 'Not authorized to view another student\'s report card' });
        }

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
        // Validate ObjectId format
        if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ message: 'Invalid marks ID format' });
        }
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

// @route   GET /api/marks/class/:classId/summary
// @desc    Class-wise marks summary across all exams
// @access  Private (Teacher/Admin)
router.get('/class/:classId/summary', auth, async (req, res) => {
    try {
        // Get all exams for this class
        const exams = await Exam.find({
            class: req.params.classId,
            isStandardized: true
        }).populate('subject', 'name').lean();

        // Get all students in class
        const students = await User.find({
            currentClass: req.params.classId,
            role: 'student'
        }).select('name email').lean();

        // Get all marks for these exams
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({
            exam: { $in: examIds }
        }).populate('student', 'name').lean();

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

// @route   GET /api/marks/analytics/class/:classId
// @desc    Detailed class analytics with student rankings
// @access  Private (Teacher/Admin)
router.get('/analytics/class/:classId', auth, async (req, res) => {
    try {
        const { examType } = req.query;

        // Build exam query
        let examQuery = {
            class: req.params.classId,
            isStandardized: true
        };

        if (examType) {
            examQuery.standardizedType = examType;
        }

        // Get exams
        const exams = await Exam.find(examQuery).populate('subject', 'name').lean();

        // Get all students
        const students = await User.find({
            currentClass: req.params.classId,
            role: 'student'
        }).select('name email').lean();

        // Get all marks
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({
            exam: { $in: examIds }
        }).populate('student', 'name').lean();

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

module.exports = router;
