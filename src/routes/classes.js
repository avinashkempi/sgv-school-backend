const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const ClassContent = require('../models/ClassContent');
const User = require('../models/User');
const AcademicYear = require('../models/AcademicYear');
const Timetable = require('../models/Timetable');
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const { yearContext } = require('../middleware/yearContext');
const _notificationService = require('../services/notificationService');
const { cacheGet, cacheSet, cacheInvalidatePattern } = require('../config/redis');

// In-memory cache for classes list (5-minute TTL)
const classesListCache = new Map();
const CLASSES_CACHE_TTL_MS = 5 * 60 * 1000;
const CLASSES_REDIS_TTL = 300; // 5 minutes

const invalidateClassesCache = async () => {
    classesListCache.clear();
    try {
        await cacheInvalidatePattern('classes:list:*');
    } catch (_) {}
};

// @route   GET /api/classes
// @desc    Get all classes
// @access  Private
router.get('/', [auth, yearContext], async (req, res) => {
    try {
        const yearCtx = req.academicYearContext || 'all';
        const cacheKey = `classes:list:${yearCtx}`;

        // 1. In-memory check (<0.01ms)
        const mem = classesListCache.get(cacheKey);
        if (mem && Date.now() - mem.ts < CLASSES_CACHE_TTL_MS) {
            return res.json(mem.data);
        }

        // 2. Redis check (~1ms)
        try {
            const redisData = await cacheGet(cacheKey);
            if (redisData) {
                classesListCache.set(cacheKey, { data: redisData, ts: Date.now() });
                return res.json(redisData);
            }
        } catch (_) {}

        // 3. Database lookup
        const classes = await Class.find({ academicYear: req.academicYearContext })
            .populate('classTeacher', 'name email profilePhoto')
            .sort({ name: 1 })
            .lean();

        classesListCache.set(cacheKey, { data: classes, ts: Date.now() });
        cacheSet(cacheKey, classes, CLASSES_REDIS_TTL).catch(() => {});

        res.json(classes);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/classes/my-classes
// @desc    Get classes where the logged-in user is the teacher
// @access  Private (Teacher)
router.get('/my-classes', [auth, yearContext], async (req, res) => {
    try {
        const classes = await Class.find({ 
            classTeacher: req.user.userId,
            academicYear: req.academicYearContext 
        })
            .populate('classTeacher', 'name email profilePhoto')
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
router.get('/admin/init', [auth, checkRole(['admin', 'super admin']), yearContext], async (req, res) => {
    try {
        const [classes, academicYears, teachers, subjects, timetables] = await Promise.all([
            Class.find({ academicYear: req.academicYearContext }).populate('classTeacher', 'name email profilePhoto').sort({ name: 1 }).lean(),
            AcademicYear.find().sort({ startDate: -1 }),
            User.find({ role: { $nin: ['student', 'super admin', 'support_staff'] } }).select('name email role profilePhoto'),
            Subject.find({ academicYear: req.academicYearContext }).populate('teachers', 'name email profilePhoto'),
            Timetable.find({
                $or: [
                    { academicYear: req.academicYearContext },
                    { academicYear: { $exists: false } },
                    { academicYear: null }
                ]
            })
                .populate({ path: 'schedule.periods.subject', select: 'name code' })
                .populate({ path: 'schedule.periods.teacher', select: 'name' })
        ]);

        // Aggregate student counts per class for the selected academic year
        const studentCounts = await User.aggregate([
            { 
                $match: { 
                    role: 'student', 
                    currentClass: { $exists: true, $ne: null },
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                } 
            },
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
        // Validate ObjectId format to prevent casting errors
        if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ msg: 'Invalid class ID format' });
        }
        const classData = await Class.findById(req.params.id).populate('classTeacher', 'name email profilePhoto role phone phone2 designation address joiningDate remarks');
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
// @access  Private (Admin, Class/Subject Teacher, Enrolled Student)
router.get('/:id/full-details', auth, async (req, res) => {
    try {
        const classId = req.params.id;
        if (!classId.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ msg: 'Invalid class ID format' });
        }

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';

        // Check if student belongs to this class or if teacher teaches this class
        if (userRole === 'student') {
            const user = await User.findById(req.user.userId).select('currentClass');
            const studentClassId = user?.currentClass?.toString();
            if (!studentClassId || studentClassId !== classId) {
                return res.status(403).json({ msg: 'Access denied: You are not enrolled in this class' });
            }
        } else if (userRole === 'teacher') {
            const isClassTeacher = await Class.exists({ _id: classId, classTeacher: req.user.userId });
            const isSubjectTeacher = await Subject.exists({ class: classId, teachers: req.user.userId });
            if (!isClassTeacher && !isSubjectTeacher && !isAdmin) {
                return res.status(403).json({ msg: 'Access denied: You do not teach this class' });
            }
        }

        // PII sanitation: exclude personal contact / address / remarks details unless admin or class teacher
        const teacherSelect = isAdmin
            ? 'name email profilePhoto role phone phone2 designation address joiningDate remarks'
            : 'name email profilePhoto role designation';

        const studentSelect = isAdmin
            ? '-password'
            : 'name rollNumber profileImage currentClass academicYear gender';

        const [classData, subjects, students] = await Promise.all([
            Class.findById(classId).populate('classTeacher', teacherSelect),
            Subject.find({ class: classId }).populate('teachers', teacherSelect).sort({ name: 1 }),
            User.find({ currentClass: classId, role: 'student' })
                .select(studentSelect)
                .populate('currentClass', 'name')
                .populate('academicYear', 'name')
                .sort({ name: 1 })
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
router.post('/', [auth, checkRole(['super admin']), yearContext], async (req, res) => {
    const { name, section, branch, classTeacher } = req.body;

    try {
        const trimmedName = (name || '').trim();
        const trimmedSection = (section || '').trim();
        const classValue = trimmedName.toLowerCase().replace(/\s+/g, '_');
        const classLabel = trimmedSection ? `${trimmedName} - ${trimmedSection}` : trimmedName;

        const newClass = new Class({
            name: trimmedName,
            value: classValue,
            label: classLabel,
            section: trimmedSection,
            branch: branch || 'Main',
            classTeacher: (classTeacher && typeof classTeacher === 'string' && classTeacher.trim())
                ? classTeacher.trim()
                : (classTeacher && typeof classTeacher === 'object' && classTeacher._id)
                    ? classTeacher._id
                    : null,
            academicYear: req.academicYearContext
        });

        const savedClass = await newClass.save();
        invalidateClassesCache().catch(() => {});
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

        if (name !== undefined) {
            classData.name = (name || '').trim();
        }
        if (section !== undefined) {
            classData.section = (section || '').trim();
        }
        if (branch !== undefined) {
            classData.branch = branch;
        }

        const finalName = classData.name || '';
        const finalSection = classData.section || '';
        classData.value = finalName.toLowerCase().replace(/\s+/g, '_');
        classData.label = finalSection ? `${finalName} - ${finalSection}` : finalName;

        if (classTeacher !== undefined) {
            classData.classTeacher = (classTeacher && typeof classTeacher === 'string' && classTeacher.trim())
                ? classTeacher.trim()
                : (classTeacher && typeof classTeacher === 'object' && classTeacher._id)
                    ? classTeacher._id
                    : null;
        }

        await classData.save();
        invalidateClassesCache().catch(() => {});
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
        invalidateClassesCache().catch(() => {});

        res.json({ msg: 'Class removed' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});



// @route   POST /api/classes/:id/content
// @desc    Create content for a class (Class Teacher, Subject Teacher, Admin, Super Admin)
// @access  Private
router.post('/:id/content', auth, async (req, res) => {
    const { title, description, type, subject, link, attachments } = req.body;
    const classId = req.params.id;

    try {
        const classData = await Class.findById(classId);
        if (!classData) return res.status(404).json({ msg: 'Class not found' });

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isClassTeacher = classData.classTeacher && classData.classTeacher.toString() === req.user.userId;

        let isSubjectTeacher = false;
        const targetSubjectId = (subject && subject !== '' && subject !== 'general') ? subject : null;

        if (targetSubjectId) {
            isSubjectTeacher = await Subject.exists({ _id: targetSubjectId, class: classId, teachers: req.user.userId });
        } else if (userRole === 'teacher') {
            isSubjectTeacher = await Subject.exists({ class: classId, teachers: req.user.userId });
        }

        if (!isAdmin && !isClassTeacher && !isSubjectTeacher) {
            return res.status(403).json({ msg: 'Not authorized to post in this class or subject' });
        }

        // Normalize attachments (array of objects or URLs)
        let normalizedAttachments = [];
        if (Array.isArray(attachments) && attachments.length > 0) {
            normalizedAttachments = attachments;
        } else if (link && typeof link === 'string' && link.trim()) {
            normalizedAttachments = [{ url: link.trim(), fileType: 'link', name: link.trim() }];
        }

        const newContent = new ClassContent({
            title: title ? title.trim() : '',
            description: description ? description.trim() : '',
            type: type || 'note',
            subject: targetSubjectId,
            class: classId,
            author: req.user.userId,
            attachments: normalizedAttachments
        });

        const savedContent = await newContent.save();

        // Populate author and subject for response
        await savedContent.populate('author', 'name role profilePhoto designation');
        if (targetSubjectId) {
            await savedContent.populate('subject', 'name code');
        }

        // Send push notification to active enrolled students of this class
        try {
            _notificationService.sendClassContentNotification(classId, savedContent);
        } catch (notifErr) {
            console.error('[Class Content] Notification error:', notifErr);
        }

        res.json(savedContent);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});




// @route   POST /api/classes/:id/students
// @desc    Add one or more students to a class
// @access  Class Teacher (for their class) or Admin/Super Admin
router.post('/:id/students', [auth, yearContext], async (req, res) => {
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

        // Verify context academic year
        const academicYearId = req.academicYearContext;
        if (!academicYearId) {
            return res.status(400).json({
                success: false,
                message: 'No academic year context found.'
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
                student.academicYear = academicYearId;
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
            .populate('teachers', 'name email profilePhoto')
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
router.post('/:id/subjects', [auth, yearContext], async (req, res) => {
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

        // Verify context academic year
        const academicYearId = req.academicYearContext;
        if (!academicYearId) {
            return res.status(400).json({ success: false, message: 'No academic year context found.' });
        }

        const newSubject = new Subject({
            name: subjectName,
            class: classId,
            globalSubject: globalSubjectRef,
            academicYear: academicYearId,
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

// @route   GET /api/classes/:id/content
// @desc    Get all content for a class with optional filtering by type, subject, and search
// @access  Private (Admin, Super Admin, Class/Subject Teacher, Enrolled Student)
router.get('/:id/content', auth, async (req, res) => {
    try {
        const classId = req.params.id;
        const userRole = req.user.role;

        // Security check: If student, ensure they belong to this class
        if (userRole === 'student') {
            const user = await User.findById(req.user.userId).select('currentClass');
            const studentClassId = user?.currentClass?.toString();
            if (!studentClassId || studentClassId !== classId) {
                return res.status(403).json({ msg: 'Access denied: You are not enrolled in this class' });
            }
        }

        const { type, subjectId, search } = req.query;
        const query = { class: classId };

        if (type && type !== 'all') {
            query.type = type;
        }

        if (subjectId && subjectId !== 'all') {
            if (subjectId === 'general') {
                query.subject = { $in: [null, undefined] };
            } else {
                query.subject = subjectId;
            }
        }

        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim(), 'i');
            query.$or = [
                { title: searchRegex },
                { description: searchRegex }
            ];
        }

        const content = await ClassContent.find(query)
            .populate('author', 'name role profilePhoto designation')
            .populate('subject', 'name code')
            .sort({ createdAt: -1 });

        res.json(content);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/classes/:id/content/:contentId
// @desc    Delete a class content item
// @access  Private (Admin, Super Admin, Class Teacher, or Author)
router.delete('/:id/content/:contentId', auth, async (req, res) => {
    try {
        const { id: classId, contentId } = req.params;
        const classData = await Class.findById(classId);
        if (!classData) return res.status(404).json({ msg: 'Class not found' });

        const contentItem = await ClassContent.findById(contentId);
        if (!contentItem) return res.status(404).json({ msg: 'Content not found' });

        // Ensure content belongs to this class
        if (contentItem.class.toString() !== classId) {
            return res.status(400).json({ msg: 'Content does not belong to this class' });
        }

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isClassTeacher = classData.classTeacher && classData.classTeacher.toString() === req.user.userId;
        const isAuthor = contentItem.author && contentItem.author.toString() === req.user.userId;

        if (!isAdmin && !isClassTeacher && !isAuthor) {
            return res.status(403).json({ msg: 'Not authorized to delete this content' });
        }

        await ClassContent.findByIdAndDelete(contentId);
        res.json({ success: true, message: 'Content deleted successfully' });
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
            .populate('author', 'name role profilePhoto designation')
            .populate('subject', 'name code')
            .sort({ createdAt: -1 });
        res.json(content);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;

