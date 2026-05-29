const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const Timetable = require('../models/Timetable');
const User = require('../models/User');
const _Class = require('../models/Class');

// @route   POST /api/timetable
// @desc    Create or Update timetable for a class
// @access  Private (Admin, Super Admin)
router.post('/', auth, async (req, res) => {
    try {
        const { classId, schedule, breaks } = req.body;

        // Check if admin or super admin
        const user = await User.findById(req.user.userId);
        if (user.role !== 'admin' && user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        let timetable = await Timetable.findOne({ class: classId });

        if (timetable) {
            // Update
            timetable.schedule = schedule;
            timetable.breaks = breaks;
            timetable.updatedAt = Date.now();
        } else {
            // Create
            timetable = new Timetable({
                class: classId,
                schedule,
                breaks
            });
        }

        await timetable.save();
        res.json(timetable);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/timetable/all
// @desc    Get all classes' timetables (read-only, for teachers/staff/support_staff/super admin)
// @access  Private (Teacher, Staff, Support Staff, Admin, Super Admin)
router.get('/all', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        const allowedRoles = ['teacher', 'staff', 'support_staff', 'admin', 'super admin'];
        if (!allowedRoles.includes(user.role)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const timetables = await Timetable.find({})
            .populate('class', 'name section branch')
            .populate({
                path: 'schedule.periods.subject',
                select: 'name code'
            })
            .populate({
                path: 'schedule.periods.teacher',
                select: 'name'
            });

        res.json(timetables);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/timetable/class/:classId
// @desc    Get timetable for a class
// @access  Private
router.get('/class/:classId', auth, async (req, res) => {
    try {
        const timetable = await Timetable.findOne({ class: req.params.classId })
            .populate({
                path: 'schedule.periods.subject',
                select: 'name code'
            })
            .populate({
                path: 'schedule.periods.teacher',
                select: 'name'
            });

        if (!timetable) {
            return res.status(404).json({ message: 'Timetable not found' });
        }

        res.json(timetable);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/timetable/my-timetable
// @desc    Get student's timetable
// @access  Private (Student)
router.get('/my-timetable', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (user.role !== 'student') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        if (!user.currentClass) {
            return res.status(400).json({ message: 'Student not assigned to a class' });
        }

        // Handle both populated and unpopulated currentClass
        const classId = user.currentClass._id || user.currentClass;

        const timetable = await Timetable.findOne({ class: classId })
            .populate({
                path: 'schedule.periods.subject',
                select: 'name'
            })
            .populate({
                path: 'schedule.periods.teacher',
                select: 'name'
            });

        if (!timetable) {
            return res.status(404).json({ message: 'Timetable not found' });
        }

        res.json(timetable);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/timetable/my-schedule
// @desc    Get teacher's schedule (aggregated)
// @access  Private (Teacher)
router.get('/my-schedule', auth, async (req, res) => {
    try {
        // Find all timetables where this teacher has a period
        const timetables = await Timetable.find({
            'schedule.periods.teacher': req.user.userId
        })
            .populate('class', 'name section')
            .populate('schedule.periods.subject', 'name');

        // Aggregate into a day-wise schedule
        const mySchedule = {
            Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: []
        };

        timetables.forEach(timetable => {
            // Skip if class is deleted or not populated
            if (!timetable.class) return;

            timetable.schedule.forEach(daySchedule => {
                const day = daySchedule.day;
                if (mySchedule[day]) {
                    daySchedule.periods.forEach(period => {

                        if (period.teacher && period.teacher.toString() === req.user.userId) {

                            mySchedule[day].push({
                                ...period.toObject(),
                                className: `${timetable.class.name} ${timetable.class.section}`,
                                classId: timetable.class._id
                            });
                        }
                    });
                }
            });
        });

        // Sort periods by time (simple string comparison works for 24h or consistent AM/PM if formatted right, 
        // but ideally we'd parse. For now assuming consistent input or sorting on client)

        res.json(mySchedule);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
