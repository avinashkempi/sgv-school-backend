const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const GradeConfig = require('../models/GradeConfig');
const User = require('../models/User');
const Subject = require('../models/Subject');
const Class = require('../models/Class');

// @route   GET /api/exams/standardized
// @desc    Get status of standardized exams for a class/subject
// @access  Private (Teacher)
router.get('/standardized', auth, async (req, res) => {
    try {
        const { classId, subjectId } = req.query;

        if (!classId || !subjectId) {
            return res.status(400).json({ message: 'Class ID and Subject ID are required' });
        }

        // Get active academic year
        const AcademicYear = require('../models/AcademicYear');
        const activeYear = await AcademicYear.findOne({ isActive: true });

        if (!activeYear) {
            return res.status(404).json({ message: 'No active academic year found' });
        }

        const standardizedTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const exams = await Exam.find({
            class: classId,
            subject: subjectId,
            academicYear: activeYear._id,
            isStandardized: true
        });

        const result = await Promise.all(standardizedTypes.map(async (type) => {
            const exam = exams.find(e => e.standardizedType === type);
            let marksCount = 0;

            if (exam) {
                marksCount = await Marks.countDocuments({ exam: exam._id });
            }

            return {
                type,
                exists: !!exam,
                exam: exam || null,
                marksEntered: marksCount > 0,
                marksCount
            };
        }));

        res.json(result);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/exams/standardized
// @desc    Create/Initialize a standardized exam
// @access  Private (Teacher)
router.post('/standardized', auth, async (req, res) => {
    try {
        const { type, classId, subjectId, totalMarks, date, instructions, duration } = req.body;

        if (!['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'].includes(type)) {
            return res.status(400).json({ message: 'Invalid exam type. Must be one of: FA1, FA2, SA1, FA3, FA4, SA2' });
        }

        if (!totalMarks || totalMarks <= 0) {
            return res.status(400).json({ message: 'Total marks must be greater than 0' });
        }

        // Validate teacher authorization
        const subject = await Subject.findById(subjectId);
        if (!subject) {
            return res.status(404).json({ message: 'Subject not found' });
        }

        if (!subject.teachers.includes(req.user.userId)) {
            return res.status(403).json({ message: 'Not authorized to create exam for this subject' });
        }

        // Get active academic year
        const AcademicYear = require('../models/AcademicYear');
        const activeYear = await AcademicYear.findOne({ isActive: true });

        if (!activeYear) {
            return res.status(404).json({ message: 'No active academic year found' });
        }

        // Check if already exists
        let exam = await Exam.findOne({
            class: classId,
            subject: subjectId,
            academicYear: activeYear._id,
            standardizedType: type,
            isStandardized: true
        });

        if (exam) {
            return res.status(400).json({ message: `${type} exam already exists for this subject and class` });
        }

        // Get full exam name
        const examNames = {
            'FA1': 'Formative Assessment 1',
            'FA2': 'Formative Assessment 2',
            'SA1': 'Summative Assessment 1',
            'FA3': 'Formative Assessment 3',
            'FA4': 'Formative Assessment 4',
            'SA2': 'Summative Assessment 2'
        };

        exam = new Exam({
            name: examNames[type],
            type: type.startsWith('SA') ? 'mid-term' : 'unit-test',
            isStandardized: true,
            standardizedType: type,
            class: classId,
            subject: subjectId,
            totalMarks,
            date: date || Date.now(),
            academicYear: activeYear._id,
            createdBy: req.user.userId,
            instructions,
            duration
        });

        await exam.save();

        const populatedExam = await Exam.findById(exam._id)
            .populate('class', 'name section')
            .populate('subject', 'name')
            .populate('academicYear', 'name');

        res.json(populatedExam);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/exams
// @desc    Create new exam (DEPRECATED - Use /api/exams/standardized instead)
// @access  Private (Admin only)
router.post('/', auth, async (req, res) => {
    try {
        // Only allow admins to create exams through this endpoint
        const user = await User.findById(req.user.userId);
        if (user.role !== 'admin' && user.role !== 'super admin') {
            return res.status(403).json({
                message: 'This endpoint is deprecated. Please use /api/exams/standardized to create exams with the 6 fixed assessment types (FA1, FA2, SA1, FA3, FA4, SA2)'
            });
        }

        const { name, type, classId, subjectId, totalMarks, date, instructions, duration, room } = req.body;

        // Validate teacher authorization (must teach this subject)
        const subject = await Subject.findById(subjectId);
        if (!subject) {
            return res.status(404).json({ message: 'Subject not found' });
        }

        // Get active academic year
        const AcademicYear = require('../models/AcademicYear');
        const activeYear = await AcademicYear.findOne({ isActive: true });

        const exam = new Exam({
            name,
            type,
            class: classId,
            subject: subjectId,
            totalMarks,
            date: date || Date.now(),
            academicYear: activeYear ? activeYear._id : null,
            createdBy: req.user.userId,
            instructions,
            duration,
            room,
            isStandardized: false  // Mark as non-standardized for backward compatibility
        });

        await exam.save();

        const populatedExam = await Exam.findById(exam._id)
            .populate('class', 'name section')
            .populate('subject', 'name')
            .populate('createdBy', 'name');

        res.json(populatedExam);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/subject/:subjectId
// @desc    Get all standardized exams for a subject
// @access  Private (Teacher/Student)
router.get('/subject/:subjectId', auth, async (req, res) => {
    try {
        const exams = await Exam.find({
            subject: req.params.subjectId,
            isStandardized: true  // Only show standardized exams
        })
            .populate('class', 'name section')
            .populate('subject', 'name')
            .populate('createdBy', 'name')
            .sort({ date: -1 });

        res.json(exams);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Subject not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/:id
// @desc    Get exam by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
    try {
        const exam = await Exam.findById(req.params.id)
            .populate('class', 'name section')
            .populate('subject', 'name')
            .populate('createdBy', 'name')
            .populate('academicYear', 'name');

        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        res.json(exam);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ message: 'Exam not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/exams/:id
// @desc    Update exam
// @access  Private (Teacher - creator only)
router.put('/:id', auth, async (req, res) => {
    try {
        let exam = await Exam.findById(req.params.id);

        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Check if user is the creator
        if (exam.createdBy.toString() !== req.user.userId) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { totalMarks, date, instructions, duration } = req.body;

        // For standardized exams, don't allow changing name or type
        if (totalMarks) exam.totalMarks = totalMarks;
        if (date) exam.date = date;
        if (instructions !== undefined) exam.instructions = instructions;
        if (duration) exam.duration = duration;

        await exam.save();

        exam = await Exam.findById(exam._id)
            .populate('class', 'name section')
            .populate('subject', 'name')
            .populate('createdBy', 'name');

        res.json(exam);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/exams/:id
// @desc    Delete exam (and all associated marks)
// @access  Private (Teacher - creator only OR Admin)
router.delete('/:id', auth, async (req, res) => {
    try {
        const exam = await Exam.findById(req.params.id);

        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        const user = await User.findById(req.user.userId);

        // Check authorization
        if (exam.createdBy.toString() !== req.user.userId && user.role !== 'admin' && user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        // Delete all marks for this exam
        await Marks.deleteMany({ exam: req.params.id });

        // Delete exam
        await Exam.findByIdAndDelete(req.params.id);

        res.json({ message: 'Exam and associated marks deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/schedule/student
// @desc    Get upcoming standardized exams for the logged-in student
// @access  Private (Student)
router.get('/schedule/student', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'student') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        if (!user.currentClass) {
            return res.status(400).json({ message: 'Student not assigned to a class' });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const exams = await Exam.find({
            class: user.currentClass,
            date: { $gte: today },
            isStandardized: true  // Only show standardized exams
        })
            .populate('subject', 'name')
            .populate('class', 'name section')
            .sort({ date: 1 });

        res.json(exams);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/schedule/class/:classId
// @desc    Get all standardized exams for a specific class (Admin/Teacher view)
// @access  Private
router.get('/schedule/class/:classId', auth, async (req, res) => {
    try {
        const exams = await Exam.find({
            class: req.params.classId,
            isStandardized: true  // Only show standardized exams
        })
            .populate('subject', 'name')
            .populate('createdBy', 'name')
            .sort({ date: 1 });

        res.json(exams);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/history
// @desc    Get exam history (past date)
// @access  Private (Teacher/Admin)
router.get('/history', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Start of today

        let query = {
            date: { $lt: today },
            isStandardized: true  // Only show standardized exams
        };

        // If teacher, only show their exams
        if (user.role === 'class teacher' || user.role === 'staff') {
            query.createdBy = req.user.userId;
        }

        if (user.role === 'student') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const exams = await Exam.find(query)
            .populate('class', 'name section')
            .populate('subject', 'name')
            .populate('createdBy', 'name')
            .sort({ date: -1 });

        res.json(exams);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/performance/class/:classId
// @desc    Get exam-wise performance for a class
// @access  Private (Class Teacher/Admin)
router.get('/performance/class/:classId', auth, async (req, res) => {
    try {
        const { academicYearId } = req.query;
        const user = await User.findById(req.user.userId);

        // Get active academic year if not provided
        let yearId = academicYearId;
        if (!yearId) {
            const AcademicYear = require('../models/AcademicYear');
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }

        // Get all standardized exams for this class
        const exams = await Exam.find({
            class: req.params.classId,
            academicYear: yearId,
            isStandardized: true
        }).populate('subject', 'name');

        // Get all students in the class
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
        const performance = examTypes.map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);
            const examIdsForType = typeExams.map(e => e._id.toString());
            const marksForType = allMarks.filter(m => examIdsForType.includes(m.exam.toString()));

            let totalMarks = 0;
            let obtainedMarks = 0;
            let studentsWithMarks = new Set();

            marksForType.forEach(mark => {
                const exam = typeExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalMarks += exam.totalMarks;
                    obtainedMarks += mark.marksObtained;
                    studentsWithMarks.add(mark.student._id.toString());
                }
            });

            const avgPercentage = totalMarks > 0 ? ((obtainedMarks / totalMarks) * 100).toFixed(2) : 0;
            const highest = marksForType.length > 0 ? Math.max(...marksForType.map(m => m.percentage)) : 0;
            const lowest = marksForType.length > 0 ? Math.min(...marksForType.map(m => m.percentage)) : 0;

            return {
                examType: type,
                subjectsCount: typeExams.length,
                studentsWithMarks: studentsWithMarks.size,
                totalStudents: students.length,
                avgPercentage: parseFloat(avgPercentage),
                highest,
                lowest,
                isComplete: typeExams.length > 0 && studentsWithMarks.size === students.length
            };
        });

        res.json({
            classId: req.params.classId,
            totalStudents: students.length,
            performance
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/performance/subject/:subjectId
// @desc    Get exam-wise performance for a subject
// @access  Private (Subject Teacher/Admin)
router.get('/performance/subject/:subjectId', auth, async (req, res) => {
    try {
        const { academicYearId, classId } = req.query;

        // Get active academic year if not provided
        let yearId = academicYearId;
        if (!yearId) {
            const AcademicYear = require('../models/AcademicYear');
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }

        // Build query
        let examQuery = {
            subject: req.params.subjectId,
            academicYear: yearId,
            isStandardized: true
        };

        if (classId) {
            examQuery.class = classId;
        }

        // Get all standardized exams for this subject
        const exams = await Exam.find(examQuery).populate('class', 'name section');

        // Get all marks for these exams
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({
            exam: { $in: examIds }
        });

        // Group by exam type and class
        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const performance = examTypes.map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);

            const classwiseData = typeExams.map(exam => {
                const marksForExam = allMarks.filter(m => m.exam.toString() === exam._id.toString());

                let totalObtained = 0;
                marksForExam.forEach(m => totalObtained += m.marksObtained);

                const avgPercentage = marksForExam.length > 0
                    ? ((totalObtained / (exam.totalMarks * marksForExam.length)) * 100).toFixed(2)
                    : 0;

                const highest = marksForExam.length > 0 ? Math.max(...marksForExam.map(m => m.percentage)) : 0;
                const lowest = marksForExam.length > 0 ? Math.min(...marksForExam.map(m => m.percentage)) : 0;

                return {
                    classId: exam.class._id,
                    className: `${exam.class.name} ${exam.class.section || ''}`,
                    studentsCount: marksForExam.length,
                    avgPercentage: parseFloat(avgPercentage),
                    highest,
                    lowest
                };
            });

            // Overall for this exam type
            const allMarksForType = allMarks.filter(m =>
                typeExams.some(e => e._id.toString() === m.exam.toString())
            );

            let overallTotal = 0;
            let overallObtained = 0;
            typeExams.forEach(exam => {
                const marksForExam = allMarksForType.filter(m => m.exam.toString() === exam._id.toString());
                marksForExam.forEach(m => {
                    overallTotal += exam.totalMarks;
                    overallObtained += m.marksObtained;
                });
            });

            const overallAvg = overallTotal > 0 ? ((overallObtained / overallTotal) * 100).toFixed(2) : 0;

            return {
                examType: type,
                overallAvgPercentage: parseFloat(overallAvg),
                classwiseData
            };
        });

        res.json({
            subjectId: req.params.subjectId,
            performance
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/performance/school
// @desc    Get school-wide exam performance
// @access  Private (Admin/Super Admin)
router.get('/performance/school', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (user.role !== 'admin' && user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { academicYearId } = req.query;

        // Get active academic year if not provided
        let yearId = academicYearId;
        if (!yearId) {
            const AcademicYear = require('../models/AcademicYear');
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }

        // Get all standardized exams for this academic year
        const exams = await Exam.find({
            academicYear: yearId,
            isStandardized: true
        }).populate('class', 'name section')
            .populate('subject', 'name');

        // Get all marks for these exams
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({
            exam: { $in: examIds }
        });

        // Group by exam type
        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const schoolPerformance = examTypes.map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);
            const examIdsForType = typeExams.map(e => e._id.toString());
            const marksForType = allMarks.filter(m => examIdsForType.includes(m.exam.toString()));

            let totalMarks = 0;
            let obtainedMarks = 0;

            marksForType.forEach(mark => {
                const exam = typeExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalMarks += exam.totalMarks;
                    obtainedMarks += mark.marksObtained;
                }
            });

            const avgPercentage = totalMarks > 0 ? ((obtainedMarks / totalMarks) * 100).toFixed(2) : 0;

            return {
                examType: type,
                examsCount: typeExams.length,
                marksEntered: marksForType.length,
                avgPercentage: parseFloat(avgPercentage)
            };
        });

        // Class-wise summary
        const Class = require('../models/Class');
        const classes = await Class.find();
        const classwiseSummary = classes.map(cls => {
            const classExams = exams.filter(e => e.class._id.toString() === cls._id.toString());
            const classExamIds = classExams.map(e => e._id.toString());
            const classMarks = allMarks.filter(m => classExamIds.includes(m.exam.toString()));

            let totalMarks = 0;
            let obtainedMarks = 0;

            classMarks.forEach(mark => {
                const exam = classExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalMarks += exam.totalMarks;
                    obtainedMarks += mark.marksObtained;
                }
            });

            const avgPercentage = totalMarks > 0 ? ((obtainedMarks / totalMarks) * 100).toFixed(2) : 0;

            return {
                classId: cls._id,
                className: `${cls.name} ${cls.section || ''}`,
                examsCount: classExams.length,
                avgPercentage: parseFloat(avgPercentage)
            };
        });

        // Subject-wise summary
        const Subject = require('../models/Subject');
        const subjects = await Subject.find();
        const subjectwiseSummary = subjects.map(subj => {
            const subjectExams = exams.filter(e => e.subject._id.toString() === subj._id.toString());
            const subjectExamIds = subjectExams.map(e => e._id.toString());
            const subjectMarks = allMarks.filter(m => subjectExamIds.includes(m.exam.toString()));

            let totalMarks = 0;
            let obtainedMarks = 0;

            subjectMarks.forEach(mark => {
                const exam = subjectExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalMarks += exam.totalMarks;
                    obtainedMarks += mark.marksObtained;
                }
            });

            const avgPercentage = totalMarks > 0 ? ((obtainedMarks / totalMarks) * 100).toFixed(2) : 0;

            return {
                subjectId: subj._id,
                subjectName: subj.name,
                examsCount: subjectExams.length,
                avgPercentage: parseFloat(avgPercentage)
            };
        });

        res.json({
            examwisePerformance: schoolPerformance,
            classwiseSummary,
            subjectwiseSummary
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
