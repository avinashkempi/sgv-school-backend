const express = require('express');
const router = express.Router();
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const User = require('../models/User');
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');

// @route   GET /api/teachers/my-subjects
// @desc    Get all subjects the teacher teaches (across all classes)
// @access  Private (Teacher)
router.get('/my-subjects', auth, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Find all subjects where this teacher is assigned
        let subjects = await Subject.find({ teachers: userId })
            .populate('class', 'name section branch')
            .populate('teachers', 'name email')
            .sort({ 'class.name': 1, name: 1 });

        // Filter out subjects where class population failed
        subjects = subjects.filter(s => s.class);

        // Get classes where user is teacher
        const classTeacherClasses = await Class.find({ classTeacher: userId }).select('_id');
        const classTeacherIds = classTeacherClasses.map(c => c._id.toString());

        // Add flag to indicate if teacher is teacher of that class
        const subjectsWithFlags = subjects.map(subject => ({
            _id: subject._id,
            name: subject.name,
            class: subject.class,
            teachers: subject.teachers,
            isClassTeacher: classTeacherIds.includes(subject.class._id.toString())
        }));

        res.json({
            subjects: subjectsWithFlags,
            classTeacherOf: classTeacherIds
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/teachers/my-classes-and-subjects
// @desc    Get unified data for teacher dashboard (classes as teacher + subjects)
// @access  Private (Teacher)
router.get('/my-classes-and-subjects', auth, async (req, res) => {
    try {
        const userId = req.user.userId;

        // Get classes where user is teacher
        const asClassTeacher = await Class.find({ classTeacher: userId })
            .populate('classTeacher', 'name email')
            .sort({ name: 1 });

        // For each class, get student count and subjects this teacher teaches
        const classesWithDetails = await Promise.all(
            asClassTeacher.map(async (cls) => {
                const [studentCount, mySubjectsInClass] = await Promise.all([
                    User.countDocuments({ currentClass: cls._id, role: 'student' }),
                    Subject.find({ class: cls._id, teachers: userId }).select('name')
                ]);

                return {
                    _id: cls._id,
                    name: cls.name,
                    section: cls.section,
                    branch: cls.branch,
                    academicYear: cls.academicYear,
                    studentCount,
                    mySubjects: mySubjectsInClass.map(s => s.name)
                };
            })
        );

        // Get all subjects teacher teaches (including in other classes)
        let subjects = await Subject.find({ teachers: userId })
            .populate('class', 'name section branch')
            .sort({ name: 1 });

        // Filter out subjects where class population failed (e.g. class deleted)
        subjects = subjects.filter(s => s.class);

        // Group subjects by class
        const classTeacherIds = asClassTeacher.map(c => c._id.toString());
        const asSubjectTeacher = subjects
            .filter(s => !classTeacherIds.includes(s.class._id.toString()))
            .reduce((acc, subject) => {
                const classId = subject.class._id.toString();
                if (!acc[classId]) {
                    acc[classId] = {
                        _id: subject.class._id,
                        name: subject.class.name,
                        section: subject.class.section,
                        branch: subject.class.branch,
                        subjects: []
                    };
                }
                acc[classId].subjects.push({
                    _id: subject._id,
                    name: subject.name
                });
                return acc;
            }, {});

        res.json({
            asClassTeacher: classesWithDetails,
            asSubjectTeacher: Object.values(asSubjectTeacher),
            allMySubjects: subjects.map(s => ({
                _id: s._id,
                name: s.name,
                class: s.class,
                isClassTeacher: classTeacherIds.includes(s.class._id.toString())
            }))
        });
    } catch (err) {
        console.error('Error in my-classes-and-subjects:', err);
        console.error('Stack:', err.stack);
        res.status(500).send('Server Error: ' + err.message);
    }
});

// @route   GET /api/teachers/subjects/:subjectId/classes
// @desc    Get all classes where teacher teaches this subject
// @access  Private (Teacher)
router.get('/subjects/:subjectId/classes', auth, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        // Validate subjectId is a valid MongoDB ObjectId
        if (!req.params.subjectId.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ msg: 'Subject not found' });
        }
        
        const subject = await Subject.findById(req.params.subjectId);

        if (!subject) {
            return res.status(404).json({ msg: 'Subject not found' });
        }

        // Verify teacher teaches this subject
        if (!subject.teachers.includes(userId)) {
            return res.status(403).json({ msg: 'Not authorized to access this subject' });
        }

        // Get class details with student count
        const classData = await Class.findById(subject.class)
            .populate('classTeacher', 'name email');

        if (!classData) {
            return res.status(404).json({ msg: 'Class not found' });
        }

        const studentCount = await User.countDocuments({
            currentClass: subject.class,
            role: 'student'
        });

        res.json({
            subject,
            class: classData,
            studentCount,
            isClassTeacher: classData.classTeacher && classData.classTeacher._id.toString() === userId
        });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Subject not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/teachers/subjects/:subjectId/assign
// @desc    Assign a teacher to a subject (Admin only)
// @access  Admin/Super Admin
router.post('/subjects/:subjectId/assign', [auth, checkRole(['admin', 'super admin']), yearContext, requireOpenYear], async (req, res) => {
    const { teacherId } = req.body;

    try {
        const subject = await Subject.findById(req.params.subjectId);
        if (!subject) {
            return res.status(404).json({ success: false, message: 'Subject not found' });
        }

        const teacher = await User.findById(teacherId);
        if (!teacher) {
            return res.status(404).json({ success: false, message: 'Teacher not found' });
        }

        if (['student', 'super admin', 'support_staff'].includes(teacher.role)) {
            return res.status(400).json({ success: false, message: 'User is not authorized to be assigned as a teacher' });
        }

        // Check if already assigned
        if (subject.teachers.includes(teacherId)) {
            return res.status(400).json({ success: false, message: 'Teacher already assigned to this subject' });
        }

        // Add teacher to subject
        subject.teachers.push(teacherId);
        await subject.save();

        // Add subject to teacher's subjects array
        if (!teacher.subjects) {
            teacher.subjects = [];
        }
        if (!teacher.subjects.includes(subject._id)) {
            teacher.subjects.push(subject._id);
            await teacher.save();
        }

        res.json({
            success: true,
            message: 'Teacher assigned successfully',
            subject: await Subject.findById(subject._id)
                .populate('class', 'name section')
                .populate('teachers', 'name email')
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/teachers/subjects/:subjectId/teachers/:teacherId
// @desc    Remove a teacher from a subject (Admin only)
// @access  Admin/Super Admin
router.delete('/subjects/:subjectId/teachers/:teacherId', [auth, checkRole(['admin', 'super admin']), yearContext, requireOpenYear], async (req, res) => {
    try {
        const { subjectId, teacherId } = req.params;

        const subject = await Subject.findById(subjectId);
        if (!subject) {
            return res.status(404).json({ success: false, message: 'Subject not found' });
        }

        // Remove teacher from subject
        subject.teachers = subject.teachers.filter(t => t.toString() !== teacherId);
        await subject.save();

        // Remove subject from teacher's subjects array
        const teacher = await User.findById(teacherId);
        if (teacher && teacher.subjects) {
            teacher.subjects = teacher.subjects.filter(s => s.toString() !== subjectId);
            await teacher.save();
        }

        res.json({
            success: true,
            message: 'Teacher removed from subject successfully'
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/teachers/subjects/:subjectId/teachers
// @desc    Bulk update teachers for a subject (Admin only)
// @access  Admin/Super Admin
router.put('/subjects/:subjectId/teachers', [auth, checkRole(['admin', 'super admin']), yearContext, requireOpenYear], async (req, res) => {
    const { teacherIds } = req.body; // Array of teacher IDs

    try {
        const subject = await Subject.findById(req.params.subjectId);
        if (!subject) {
            return res.status(404).json({ success: false, message: 'Subject not found' });
        }

        // Verify all teachers exist and are valid
        const teachers = await User.find({
            _id: { $in: teacherIds },
            role: { $nin: ['student', 'super admin', 'support_staff'] }
        });

        if (teachers.length !== teacherIds.length) {
            return res.status(400).json({ success: false, message: 'One or more invalid teacher IDs' });
        }

        // Get teachers to remove (in old list but not in new list)
        const oldTeacherIds = subject.teachers.map(t => t.toString());
        const teachersToRemove = oldTeacherIds.filter(id => !teacherIds.includes(id));

        // Get teachers to add (in new list but not in old list)
        const teachersToAdd = teacherIds.filter(id => !oldTeacherIds.includes(id));

        // Update subject
        subject.teachers = teacherIds;
        await subject.save();

        // Remove subject from teachers no longer assigned
        await User.updateMany(
            { _id: { $in: teachersToRemove } },
            { $pull: { subjects: subject._id } }
        );

        // Add subject to newly assigned teachers
        await User.updateMany(
            { _id: { $in: teachersToAdd } },
            { $addToSet: { subjects: subject._id } }
        );

        res.json({
            success: true,
            message: 'Teachers updated successfully',
            subject: await Subject.findById(subject._id)
                .populate('class', 'name section')
                .populate('teachers', 'name email')
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/teachers/admin/teacher-subject-matrix
// @desc    Get complete teacher-subject assignment matrix for admin
// @access  Admin/Super Admin
router.get('/admin/teacher-subject-matrix', [auth, checkRole(['admin', 'super admin']), yearContext, requireOpenYear], async (req, res) => {
    try {
        const teachers = await User.find({
            role: { $nin: ['student', 'super admin', 'support_staff'] }
        })
            .populate({
                path: 'subjects',
                populate: { path: 'class', select: 'name section' }
            })
            .select('name email role subjects')
            .sort({ name: 1 });

        const allSubjects = await Subject.find()
            .populate('class', 'name section')
            .populate('teachers', 'name email')
            .sort({ 'class.name': 1, name: 1 });

        res.json({
            teachers,
            subjects: allSubjects
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/teachers/my-history
// @desc    Get the logged-in teacher's portfolio across past academic years
// @access  Private (Teacher)
router.get('/my-history', auth, async (req, res) => {
    try {
        const TeacherHistory = require('../models/TeacherHistory');
        const history = await TeacherHistory.find({ teacher: req.user.userId })
            .populate('academicYear', 'name startDate endDate')
            .populate('classes.class', 'name section')
            .populate('classes.subject', 'name')
            .sort({ 'academicYear.startDate': -1 });

        res.json({ success: true, history });
    } catch (err) {
        console.error('Teacher History Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// @route   GET /api/teachers/:id/history
// @desc    Get a specific teacher's portfolio history (admin view)
// @access  Admin/Super Admin
router.get('/:id/history', [auth, checkRole(['admin', 'super admin']), yearContext, requireOpenYear], async (req, res) => {
    try {
        const TeacherHistory = require('../models/TeacherHistory');
        const history = await TeacherHistory.find({ teacher: req.params.id })
            .populate('academicYear', 'name startDate endDate')
            .populate('classes.class', 'name section')
            .populate('classes.subject', 'name')
            .sort({ 'academicYear.startDate': -1 });

        res.json({ success: true, history });
    } catch (err) {
        console.error('Teacher History Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

module.exports = router;
