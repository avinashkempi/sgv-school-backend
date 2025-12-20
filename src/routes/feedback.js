const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const Feedback = require('../models/Feedback');
const User = require('../models/User');
const Subject = require('../models/Subject');
const Class = require('../models/Class');

// Helper: Check if teacher is allowed to give feedback to student
const checkTeacherPermissions = async (teacherId, studentId, classId) => {
    // 1. Check if Teacher is Class Teacher
    const classData = await Class.findById(classId);
    if (classData && classData.classTeacher && classData.classTeacher.toString() === teacherId) {
        return { allowed: true, type: 'class_teacher' };
    }

    // 2. Check if Teacher teaches ANY subject to this class
    const subjects = await Subject.find({ class: classId, teachers: teacherId });
    if (subjects.length > 0) {
        return { allowed: true, type: 'subject_teacher', subjects: subjects.map(s => s._id.toString()) };
    }

    return { allowed: false };
};

// @route   POST /api/feedback
// @desc    Create feedback for a student
// @access  Teacher, Admin, Super Admin
router.post('/', [auth, checkRole(['teacher', 'admin', 'super admin'])], async (req, res) => {
    const { studentId, message, subjectId } = req.body;
    const teacherId = req.user.userId;
    const role = req.user.role;

    try {
        const student = await User.findById(studentId).populate('currentClass');
        if (!student || student.role !== 'student') {
            return res.status(404).json({ message: 'Student not found' });
        }

        if (!student.currentClass) {
            return res.status(400).json({ message: 'Student is not assigned to any class' });
        }

        const classId = student.currentClass._id;

        // Validation for Teachers
        if (role === 'teacher') {
            const permission = await checkTeacherPermissions(teacherId, student._id, classId);

            if (!permission.allowed) {
                return res.status(403).json({ message: 'You are not authorized to give feedback to this student. You must be their Class Teacher or Subject Teacher.' });
            }

            // If Subject Teacher, validate subjectId or ensure they teach at least one subject if generic
            if (subjectId) {
                const subject = await Subject.findById(subjectId);
                if (!subject || subject.class.toString() !== classId.toString()) {
                    return res.status(400).json({ message: 'Invalid subject for this class' });
                }
                if (!subject.teachers.includes(teacherId)) {
                    return res.status(403).json({ message: 'You do not teach this subject' });
                }
            } else {
                // Generic feedback: strictly allowed for Class Teachers. 
                // For Subject Teachers, we might require selecting a subject, but plan says "Must/Should".
                // Let's enforce: If not class teacher, MUST select subject.
                if (permission.type !== 'class_teacher') {
                    return res.status(400).json({ message: 'Subject teachers must select a subject for the feedback.' });
                }
            }
        }

        const feedback = new Feedback({
            student: studentId,
            teacher: teacherId,
            class: classId,
            subject: subjectId || null,
            message
        });

        const savedFeedback = await feedback.save();
        await savedFeedback.populate('student', 'name');
        await savedFeedback.populate('teacher', 'name role');
        if (subjectId) await savedFeedback.populate('subject', 'name');

        res.json(savedFeedback);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/feedback/my
// @desc    Get feedback for logged-in user
// @access  Student
router.get('/my', [auth, checkRole(['student'])], async (req, res) => {
    try {
        const feedback = await Feedback.find({ student: req.user.userId })
            .populate('teacher', 'name role')
            .populate('subject', 'name')
            .populate('class', 'name section')
            .sort({ createdAt: -1 });

        res.json(feedback);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/feedback/sent
// @desc    Get feedback sent by logged-in teacher
// @access  Teacher
router.get('/sent', [auth, checkRole(['teacher'])], async (req, res) => {
    try {
        const feedback = await Feedback.find({ teacher: req.user.userId })
            .populate('student', 'name')
            .populate('subject', 'name')
            .populate('class', 'name section')
            .sort({ createdAt: -1 });

        res.json(feedback);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/feedback/all
// @desc    Get all feedback
// @access  Admin, Super Admin
router.get('/all', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const feedback = await Feedback.find()
            .populate('student', 'name')
            .populate('teacher', 'name')
            .populate('subject', 'name')
            .populate('class', 'name section')
            .sort({ createdAt: -1 });

        res.json(feedback);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/feedback/:id
// @desc    Update feedback
// @access  Teacher (own), Admin, Super Admin
router.put('/:id', auth, async (req, res) => {
    const { message } = req.body;
    const userId = req.user.userId;
    const role = req.user.role;

    try {
        let feedback = await Feedback.findById(req.params.id);

        if (!feedback) {
            return res.status(404).json({ message: 'Feedback not found' });
        }

        // Authorization
        if (role === 'teacher') {
            if (feedback.teacher.toString() !== userId) {
                return res.status(403).json({ message: 'Not authorized to edit this feedback' });
            }
        } else if (role !== 'admin' && role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        feedback.message = message || feedback.message;
        await feedback.save();

        // Repopulate for response
        await feedback.populate('student', 'name');
        await feedback.populate('teacher', 'name role');
        if (feedback.subject) await feedback.populate('subject', 'name');

        res.json(feedback);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/feedback/:id
// @desc    Delete feedback
// @access  Teacher (own), Admin, Super Admin
router.delete('/:id', auth, async (req, res) => {
    const userId = req.user.userId;
    const role = req.user.role;

    try {
        let feedback = await Feedback.findById(req.params.id);

        if (!feedback) {
            return res.status(404).json({ message: 'Feedback not found' });
        }

        // Authorization
        if (role === 'teacher') {
            if (feedback.teacher.toString() !== userId) {
                return res.status(403).json({ message: 'Not authorized to delete this feedback' });
            }
        } else if (role !== 'admin' && role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        await Feedback.findByIdAndDelete(req.params.id);

        res.json({ message: 'Feedback deleted successfully', id: req.params.id });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
