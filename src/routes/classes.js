const express = require('express');
const router = express.Router();
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const ClassContent = require('../models/ClassContent');
const User = require('../models/User');
const AcademicYear = require('../models/AcademicYear');
const Timetable = require('../models/Timetable');
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const _notificationService = require('../services/notificationService');

// @route   GET /api/classes
// @desc    Get all classes
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const classes = await Class.find()
            .populate('classTeacher', 'name email')
            .sort({ name: 1 });
        res.json(classes);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/classes/my-classes
// @desc    Get classes where the logged-in user is the teacher
// @access  Private (Teacher)
router.get('/my-classes', auth, async (req, res) => {
    try {
        const classes = await Class.find({ classTeacher: req.user.userId })
            .populate('classTeacher', 'name email')
            .sort({ name: 1 });
        res.json(classes);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/classes/admin/init
// @desc    Get all data needed for admin classes page
// @access  Admin/Super Admin
router.get('/admin/init', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const [classes, academicYears, teachers, subjects, timetables] = await Promise.all([
            Class.find().populate('classTeacher', 'name email').sort({ name: 1 }).lean(),
            AcademicYear.find().sort({ startDate: -1 }),
            User.find({ role: { $in: ['teacher', 'staff'] } }).select('name email role'),
            Subject.find().populate('teachers', 'name email'),
            Timetable.find()
        ]);

        // Aggregate student counts per class
        const studentCounts = await User.aggregate([
            { $match: { role: 'student', currentClass: { $exists: true, $ne: null } } },
            { $group: { _id: '$currentClass', count: { $sum: 1 } } }
        ]);

        const countMap = {};
        studentCounts.forEach(c => {
            if (c._id) countMap[c._id.toString()] = c.count;
        });

        // Merge count into classes
        const classesWithCount = classes.map(cls => ({
            ...cls,
            studentCount: countMap[cls._id.toString()] || 0
        }));

        res.json({
            classes: classesWithCount,
            academicYears,
            teachers,
            subjects,
            timetables
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/classes/:id
// @desc    Get single class by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
    try {
        const classData = await Class.findById(req.params.id).populate('classTeacher', 'name email');
        if (!classData) {
            return res.status(404).json({ msg: 'Class not found' });
        }
        res.json(classData);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Class not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/classes/:id/full-details
// @desc    Get class details, subjects, and students
// @access  Private
router.get('/:id/full-details', auth, async (req, res) => {
    try {
        const [classData, subjects, students] = await Promise.all([
            Class.findById(req.params.id).populate('classTeacher', 'name email'),
            Subject.find({ class: req.params.id }).populate('teachers', 'name email').sort({ name: 1 }),
            User.find({ currentClass: req.params.id, role: 'student' }).select('name phone email admissionDate guardianName guardianPhone').sort({ name: 1 })
        ]);

        if (!classData) {
            return res.status(404).json({ msg: 'Class not found' });
        }

        res.json({
            classData,
            subjects,
            students
        });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Class not found' });
        }
        res.status(500).send('Server Error');
    }
});



// @route   POST /api/classes
// @desc    Create a new class
// @access  Super Admin
router.post('/', [auth, checkRole(['super admin'])], async (req, res) => {
    const { name, section, branch, classTeacher } = req.body;

    try {
        const newClass = new Class({
            name,
            section,
            branch,
            classTeacher
        });

        const savedClass = await newClass.save();
        res.json(savedClass);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/classes/:id
// @desc    Update a class
// @access  Super Admin
router.put('/:id', [auth, checkRole(['super admin'])], async (req, res) => {
    const { name, section, branch, classTeacher } = req.body;

    try {
        let classData = await Class.findById(req.params.id);
        if (!classData) return res.status(404).json({ msg: 'Class not found' });

        classData.name = name || classData.name;
        classData.section = section !== undefined ? section : classData.section;
        classData.branch = branch || classData.branch;
        classData.classTeacher = classTeacher || classData.classTeacher;

        await classData.save();
        res.json(classData);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/classes/:id
// @desc    Delete a class
// @access  Super Admin
router.delete('/:id', [auth, checkRole(['super admin'])], async (req, res) => {
    try {
        const classData = await Class.findById(req.params.id);
        if (!classData) return res.status(404).json({ msg: 'Class not found' });

        // Check if class has students
        const studentCount = await User.countDocuments({ currentClass: req.params.id });
        if (studentCount > 0) {
            return res.status(400).json({ msg: 'Cannot delete class with enrolled students' });
        }

        await Class.findByIdAndDelete(req.params.id);

        // Delete associated timetable
        await Timetable.findOneAndDelete({ class: req.params.id });

        res.json({ msg: 'Class removed' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});



// @route   POST /api/classes/:id/content
// @desc    Create content for a class
// @access  Class Teacher or Admin
router.post('/:id/content', auth, async (req, res) => {
    const { title, description, type, subject, link } = req.body;
    const classId = req.params.id;

    try {
        const classData = await Class.findById(classId);
        if (!classData) return res.status(404).json({ msg: 'Class not found' });

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isClassTeacher = classData.classTeacher && classData.classTeacher.toString() === req.user.userId;

        if (!isAdmin && !isClassTeacher) {
            return res.status(403).json({ msg: 'Not authorized' });
        }

        const newContent = new ClassContent({
            title,
            description,
            type,
            subject,
            class: classId,
            author: req.user.userId,
            attachments: link ? [link] : []
        });

        const savedContent = await newContent.save();

        // Populate author and subject for response
        await savedContent.populate('author', 'name');
        await savedContent.populate('subject', 'name');

        res.json(savedContent);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});



// @route   POST /api/classes/:id/students
// @desc    Add one or more students to a class
// @access  Class Teacher (for their class) or Admin/Super Admin
router.post('/:id/students', auth, async (req, res) => {
    const { studentId, studentIds } = req.body;
    const classId = req.params.id;

    try {
        // Verify the class exists
        const classData = await Class.findById(classId);
        if (!classData) {
            return res.status(404).json({
                success: false,
                message: 'Class not found'
            });
        }

        // Check authorization: must be admin/super admin
        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Only admins can add students to a class'
            });
        }

        // Find active academic year
        const activeYear = await AcademicYear.findOne({ isActive: true });
        if (!activeYear) {
            return res.status(400).json({
                success: false,
                message: 'No active academic year found. Please contact admin.'
            });
        }

        // Determine IDs to process
        const idsToProcess = studentIds || (studentId ? [studentId] : []);

        if (idsToProcess.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No students provided'
            });
        }

        // Process students
        const results = {
            added: [],
            failed: []
        };

        for (const id of idsToProcess) {
            try {
                const student = await User.findById(id);
                if (!student) {
                    results.failed.push({ id, reason: 'Student not found' });
                    continue;
                }

                if (student.role !== 'student') {
                    results.failed.push({ id, name: student.name, reason: 'User is not a student' });
                    continue;
                }

                if (student.currentClass && student.currentClass.toString() !== classId) {
                    results.failed.push({ id, name: student.name, reason: 'Already in another class' });
                    continue;
                }

                if (student.currentClass && student.currentClass.toString() === classId) {
                    // Already in this class, just skip or consider success
                    results.failed.push({ id, name: student.name, reason: 'Already in this class' });
                    continue;
                }

                // Update student
                student.currentClass = classId;
                student.academicYear = activeYear._id;
                await student.save();

                results.added.push({
                    id: student._id,
                    name: student.name,
                    phone: student.phone,
                    email: student.email
                });
            } catch (error) {
                results.failed.push({ id, reason: error.message });
            }
        }

        res.json({
            success: true,
            message: `Successfully added ${results.added.length} students`,
            results
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/classes/:id/students/:studentId
// @desc    Remove a student from a class
// @access  Class Teacher (for their class) or Admin/Super Admin
router.delete('/:id/students/:studentId', auth, async (req, res) => {
    const { id: classId, studentId } = req.params;

    try {
        // Verify the class exists
        const classData = await Class.findById(classId);
        if (!classData) {
            return res.status(404).json({
                success: false,
                message: 'Class not found'
            });
        }

        // Check authorization: must be admin/super admin
        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Only admins can remove students from a class'
            });
        }

        // Verify the student exists
        const student = await User.findById(studentId);
        if (!student) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        // Verify student is in this class
        if (!student.currentClass || student.currentClass.toString() !== classId) {
            return res.status(400).json({
                success: false,
                message: 'Student is not in this class'
            });
        }

        // Remove student from class
        student.currentClass = null;
        student.academicYear = null;
        await student.save();

        res.json({
            success: true,
            message: 'Student removed from class successfully'
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/classes/:id/subjects
// @desc    Get all subjects for a class
// @access  Private
router.get('/:id/subjects', auth, async (req, res) => {
    try {
        const subjects = await Subject.find({ class: req.params.id })
            .populate('teachers', 'name email')
            .sort({ name: 1 });
        res.json(subjects);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/classes/:id/subjects
// @desc    Add a subject to a class
// @access  Class Teacher (for their class) or Admin/Super Admin
router.post('/:id/subjects', auth, async (req, res) => {
    const { name, globalSubjectId } = req.body;
    const classId = req.params.id;

    try {
        const classData = await Class.findById(classId);
        if (!classData) {
            return res.status(404).json({ success: false, message: 'Class not found' });
        }

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        if (!isAdmin) {
            return res.status(403).json({ success: false, message: 'Only admins can add subjects' });
        }

        let subjectName = name;
        let globalSubjectRef = null;

        // If globalSubjectId is provided, fetch name from it
        if (globalSubjectId) {
            const globalSubject = await require('../models/GlobalSubject').findById(globalSubjectId);
            if (!globalSubject) {
                return res.status(404).json({ success: false, message: 'Global subject not found' });
            }
            subjectName = globalSubject.name;
            globalSubjectRef = globalSubject._id;
        } else if (!name) {
            return res.status(400).json({ success: false, message: 'Subject name or Global Subject ID is required' });
        }

        // Check if subject already exists in this class
        const existingSubject = await Subject.findOne({ class: classId, name: subjectName });
        if (existingSubject) {
            return res.status(400).json({ success: false, message: 'Subject already exists in this class' });
        }

        const newSubject = new Subject({
            name: subjectName,
            class: classId,
            globalSubject: globalSubjectRef,

            teachers: [] // Start with no teachers assigned
        });

        const savedSubject = await newSubject.save();
        res.json(savedSubject);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/classes/:id/subjects/:subjectId
// @desc    Delete a subject
// @access  Class Teacher or Admin
router.delete('/:id/subjects/:subjectId', auth, async (req, res) => {
    try {
        const { id: classId, subjectId } = req.params;

        const classData = await Class.findById(classId);
        if (!classData) return res.status(404).json({ success: false, message: 'Class not found' });

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        if (!isAdmin) {
            return res.status(403).json({ success: false, message: 'Only admins can delete subjects' });
        }

        // Check for content
        const contentCount = await ClassContent.countDocuments({ subject: subjectId });
        if (contentCount > 0) {
            return res.status(400).json({ success: false, message: 'Cannot delete subject with existing content' });
        }

        await Subject.findByIdAndDelete(subjectId);
        res.json({ success: true, message: 'Subject deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/classes/:id/subjects/:subjectId/content
// @desc    Get content for a specific subject
// @access  Private
router.get('/:id/subjects/:subjectId/content', auth, async (req, res) => {
    try {
        const content = await ClassContent.find({
            class: req.params.id,
            subject: req.params.subjectId
        })
            .populate('author', 'name')
            .sort({ createdAt: -1 });
        res.json(content);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
