const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const User = require('../models/User');
const Subject = require('../models/Subject');
const { sendTargetedNotification } = require('../services/notificationService');

// @route   POST /api/exams/quick-init
// @desc    Quick initialize all 6 exam types for a class+subject in one call
// @access  Private (Teacher)
router.post('/quick-init', [auth, yearContext, requireOpenYear], async (req, res) => {
    try {
        const { classId, subjectId, examsConfig } = req.body;
        // examsConfig: { totalMarks, duration, FA1: {date, ...}, FA2: {date, ...}, ... }
        const academicYearId = req.academicYearContext;

        // Validate teacher authorization
        const subject = await Subject.findById(subjectId);
        if (!subject) {
            return res.status(404).json({ message: 'Subject not found' });
        }

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        if (!isAdmin && !subject.teachers.includes(req.user.userId)) {
            return res.status(403).json({ message: 'Not authorized to create exams for this subject' });
        }

        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const examNames = {
            'FA1': 'Formative Assessment 1',
            'FA2': 'Formative Assessment 2',
            'SA1': 'Summative Assessment 1',
            'FA3': 'Formative Assessment 3',
            'FA4': 'Formative Assessment 4',
            'SA2': 'Summative Assessment 2'
        };

        const results = [];

        for (const type of examTypes) {
            // Check if exists
            let exam = await Exam.findOne({
                class: classId,
                subject: subjectId,
                academicYear: academicYearId,
                standardizedType: type,
                isStandardized: true
            });

            if (!exam) {
                const examConfig = examsConfig[type] || {};

                exam = new Exam({
                    name: examNames[type],
                    type: type === 'SA2' ? 'final' : (type.startsWith('SA') ? 'mid-term' : 'unit-test'),
                    isStandardized: true,
                    standardizedType: type,
                    class: classId,
                    subject: subjectId,
                    totalMarks: examConfig.totalMarks || examsConfig.totalMarks || 100,
                    date: examConfig.date || examsConfig.defaultDate || Date.now(),
                    academicYear: academicYearId,
                    createdBy: req.user.userId,
                    instructions: examConfig.instructions || examsConfig.instructions,
                    duration: examConfig.duration || examsConfig.duration,
                    startTime: examConfig.startTime,
                    endTime: examConfig.endTime,
                    status: 'scheduled'
                });
                await exam.save();
                results.push({ type, status: 'created', exam });
            } else {
                results.push({ type, status: 'exists', exam });
            }
        }

        // Notify class about new exams
        if (results.some(r => r.status === 'created')) {
            await sendTargetedNotification('class', classId, {
                title: 'New Exams Scheduled',
                message: `All exams have been scheduled for ${subject.name}. Check your schedule.`,
                type: 'Exam'
            });
        }

        res.json({
            message: 'Quick initialization complete',
            results
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/teacher/dashboard
// @desc    Get teacher's complete exam overview (all classes/subjects they teach)
// @access  Private (Teacher)
router.get('/teacher/dashboard', [auth, yearContext], async (req, res) => {
    try {
        const academicYearId = req.academicYearContext;

        // Fetch user to get role

        // Find all subjects taught by this teacher
        const subjects = await Subject.find({
            teachers: req.user.userId
        })
            .populate('class', 'name section')
            .lean();

        const dashboard = [];

        for (const subject of subjects) {
            // Get all exams for this subject
            const exams = await Exam.find({
                class: subject.class._id,
                subject: subject._id,
                academicYear: academicYearId,
                isStandardized: true
            }).lean();

            // Get marks counts
            const examIds = exams.map(e => e._id);
            const marksCounts = await Marks.aggregate([
                { $match: { exam: { $in: examIds } } },
                { $group: { _id: '$exam', count: { $sum: 1 } } }
            ]);

            const marksCountMap = {};
            marksCounts.forEach(item => {
                marksCountMap[item._id.toString()] = item.count;
            });

            // Get student count for this class
            const studentCount = await User.countDocuments({
                currentClass: subject.class._id,
                role: 'student'
            });

            const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
            const examStatus = examTypes.map(type => {
                const exam = exams.find(e => e.standardizedType === type);
                const marksCount = exam ? (marksCountMap[exam._id.toString()] || 0) : 0;

                return {
                    type,
                    exists: !!exam,
                    examId: exam?._id,
                    marksEntered: marksCount,
                    totalStudents: studentCount,
                    marksComplete: marksCount >= studentCount,
                    marksPublished: exam?.marksPublished || false,
                    status: exam?.status || null
                };
            });

            dashboard.push({
                classId: subject.class._id,
                className: `${subject.class.name} ${subject.class.section || ''}`,
                subjectId: subject._id,
                subjectName: subject.name,
                studentCount,
                examStatus,
                summary: {
                    examsCreated: examStatus.filter(e => e.exists).length,
                    marksEntered: examStatus.filter(e => e.marksEntered > 0).length,
                    marksPublished: examStatus.filter(e => e.marksPublished).length,
                    pending: examStatus.filter(e => !e.exists || !e.marksComplete).length
                }
            });
        }

        res.json({
            academicYear: academicYearId,
            dashboard
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/status-summary
// @desc    Get count of exams by status for quick overview
// @access  Private (Teacher/Admin)
router.get('/status-summary', [auth, yearContext], async (req, res) => {
    try {
        const { classId, subjectId } = req.query;
        const academicYearId = req.academicYearContext;

        let query = { academicYear: academicYearId, isStandardized: true };

        if (classId) query.class = classId;
        if (subjectId) query.subject = subjectId;

        const [statusCounts, totalExams, marksPublishedCount] = await Promise.all([
            Exam.aggregate([
                { $match: query },
                { $group: { _id: '$status', count: { $sum: 1 } } }
            ]),
            Exam.countDocuments(query),
            Exam.countDocuments({ ...query, marksPublished: true })
        ]);

        const summary = {
            total: totalExams,
            marksPublished: marksPublishedCount,
            byStatus: {}
        };

        statusCounts.forEach(item => {
            summary.byStatus[item._id] = item.count;
        });

        res.json(summary);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/exams/bulk-update
// @desc    Update multiple exams at once (dates, marks, status)
// @access  Private (Teacher/Admin)
router.put('/bulk-update', [auth, yearContext, requireOpenYear], async (req, res) => {
    try {
        const { examIds, updates } = req.body;
        // updates: { date?, totalMarks?, status?, startTime?, endTime?, instructions?, duration? }

        if (!examIds || !Array.isArray(examIds) || examIds.length === 0) {
            return res.status(400).json({ message: 'Exam IDs array is required' });
        }

        // Verify authorization for each exam
        const exams = await Exam.find({ _id: { $in: examIds } }).populate('subject');

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        for (const exam of exams) {
            if (!isAdmin && exam.createdBy.toString() !== req.user.userId) {
                // Check if user teaches this subject
                const subject = exam.subject;
                if (!subject || !subject.teachers.includes(req.user.userId)) {
                    return res.status(403).json({
                        message: `Not authorized to update exam: ${exam.name}`
                    });
                }
            }
        }

        // Perform bulk update
        const allowedFields = ['date', 'totalMarks', 'status', 'startTime', 'endTime', 'instructions', 'duration'];
        const updateData = {};

        allowedFields.forEach(field => {
            if (updates[field] !== undefined) {
                updateData[field] = updates[field];
            }
        });

        const result = await Exam.updateMany(
            { _id: { $in: examIds } },
            { $set: updateData }
        );

        res.json({
            message: 'Bulk update completed',
            modifiedCount: result.modifiedCount,
            matched: result.matchedCount
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/exams/:id/publish-marks
// @desc    Publish marks to make them visible to students
// @access  Private (Teacher/Admin)
router.post('/:id/publish-marks', [auth, yearContext, requireOpenYear], async (req, res) => {
    try {
        const exam = await Exam.findById(req.params.id).populate('subject');

        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Check authorization
        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        if (!isAdmin && exam.createdBy.toString() !== req.user.userId) {
            const subject = exam.subject;
            if (!subject || !subject.teachers.includes(req.user.userId)) {
                return res.status(403).json({ message: 'Not authorized' });
            }
        }

        exam.marksPublished = true;
        await exam.save();

        // Notify students
        await sendTargetedNotification('class', exam.class, {
            title: 'Marks Published',
            message: `Marks for ${exam.name} have been published. Check your report card.`,
            type: 'Exam'
        });

        res.json({
            message: 'Marks published successfully',
            exam
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
