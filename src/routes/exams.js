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
        const { type, classId, subjectId, totalMarks, date, instructions } = req.body;

        if (!['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'].includes(type)) {
            return res.status(400).json({ message: 'Invalid exam type' });
        }

        // Validate teacher authorization
        const subject = await Subject.findById(subjectId);
        if (!subject) {
            return res.status(404).json({ message: 'Subject not found' });
        }

        if (!subject.teachers.includes(req.user.userId)) {
            return res.status(403).json({ message: 'Not authorized' });
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
            standardizedType: type
        });

        if (exam) {
            return res.status(400).json({ message: 'Exam already exists' });
        }

        exam = new Exam({
            name: type, // Fixed name
            type: type.startsWith('SA') ? 'mid-term' : 'unit-test', // Map to existing types roughly
            isStandardized: true,
            standardizedType: type,
            class: classId,
            subject: subjectId,
            totalMarks,
            date: date || Date.now(),
            academicYear: activeYear._id,
            createdBy: req.user.userId,
            instructions
        });

        await exam.save();
        res.json(exam);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/exams
// @desc    Create new exam
// @access  Private (Teacher)
router.post('/', auth, async (req, res) => {
    try {
        const { name, type, classId, subjectId, totalMarks, date, instructions, duration, room } = req.body;

        // Validate teacher authorization (must teach this subject)
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
            room
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
// @desc    Get all exams for a subject
// @access  Private (Teacher/Student)
router.get('/subject/:subjectId', auth, async (req, res) => {
    try {
        const exams = await Exam.find({ subject: req.params.subjectId })
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

        const { name, type, totalMarks, date, instructions, duration, room } = req.body;

        if (name) exam.name = name;
        if (type) exam.type = type;
        if (totalMarks) exam.totalMarks = totalMarks;
        if (date) exam.date = date;
        if (instructions !== undefined) exam.instructions = instructions;
        if (duration) exam.duration = duration;
        if (room) exam.room = room;

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
// @desc    Get upcoming exams for the logged-in student
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
            date: { $gte: today }
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
// @desc    Get all exams for a specific class (Admin/Teacher view)
// @access  Private
router.get('/schedule/class/:classId', auth, async (req, res) => {
    try {
        const exams = await Exam.find({ class: req.params.classId })
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

        let query = { date: { $lt: today } };

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

module.exports = router;
