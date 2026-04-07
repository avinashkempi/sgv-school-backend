const express = require('express');
const router = express.Router();
const { authenticateToken: auth } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const _GradeConfig = require('../models/GradeConfig');
const User = require('../models/User');
const Subject = require('../models/Subject');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const { sendTargetedNotification } = require('../services/notificationService');

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
        const activeYear = await AcademicYear.findOne({ isActive: true }).lean();

        if (!activeYear) {
            return res.status(404).json({ message: 'No active academic year found' });
        }

        const standardizedTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];

        // 1. Fetch all standardized exams for this class/subject
        const exams = await Exam.find({
            class: classId,
            subject: subjectId,
            academicYear: activeYear._id,
            isStandardized: true
        }).lean();

        // 2. Aggregate marks counts for these exams in one query
        const examIds = exams.map(e => e._id);
        const marksCounts = await Marks.aggregate([
            { $match: { exam: { $in: examIds } } },
            { $group: { _id: '$exam', count: { $sum: 1 } } }
        ]);

        // Create a map for fast lookup: examId -> count
        const marksCountMap = {};
        marksCounts.forEach(item => {
            marksCountMap[item._id.toString()] = item.count;
        });

        // 3. Map results
        const result = standardizedTypes.map(type => {
            const exam = exams.find(e => e.standardizedType === type);
            const marksCount = exam ? (marksCountMap[exam._id.toString()] || 0) : 0;

            return {
                type,
                exists: !!exam,
                exam: exam || null,
                marksEntered: marksCount > 0,
                marksCount
            };
        });

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
        const subject = await Subject.findById(subjectId).populate('class');
        if (!subject) {
            return res.status(404).json({ message: 'Subject not found' });
        }

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isSubjectTeacher = subject.teachers.includes(req.user.userId);
        const isClassTeacher = subject.class && subject.class.classTeacher && subject.class.classTeacher.toString() === req.user.userId.toString();

        if (!isAdmin && !isSubjectTeacher && !isClassTeacher) {
            return res.status(403).json({ message: 'Not authorized to create exam for this subject' });
        }

        // Get active academic year
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
            type: type === 'SA2' ? 'final' : (type.startsWith('SA') ? 'mid-term' : 'unit-test'),
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

// @route   POST /api/exams/standardized/bulk
// @desc    Initialize all missing standardized exams for a class/subject
// @access  Private (Teacher/Admin)
router.post('/standardized/bulk', auth, async (req, res) => {
    try {
        const { classId, subjectId, totalMarks, date, instructions, duration } = req.body;

        const subject = await Subject.findById(subjectId).populate('class');
        if (!subject) {
            return res.status(404).json({ message: 'Subject not found' });
        }

        const userRole = req.user.role;
        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isSubjectTeacher = subject.teachers.includes(req.user.userId);
        const isClassTeacher = subject.class && subject.class.classTeacher && subject.class.classTeacher.toString() === req.user.userId.toString();

        if (!isAdmin && !isSubjectTeacher && !isClassTeacher) {
            return res.status(403).json({ message: 'Not authorized to create exams for this subject' });
        }

        const activeYear = await AcademicYear.findOne({ isActive: true });

        if (!activeYear) {
            return res.status(404).json({ message: 'No active academic year found' });
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
            let exam = await Exam.findOne({
                class: classId,
                subject: subjectId,
                academicYear: activeYear._id,
                standardizedType: type,
                isStandardized: true
            });

            if (!exam) {
                exam = new Exam({
                    name: examNames[type],
                    type: type === 'SA2' ? 'final' : (type.startsWith('SA') ? 'mid-term' : 'unit-test'),
                    isStandardized: true,
                    standardizedType: type,
                    class: classId,
                    subject: subjectId,
                    totalMarks: totalMarks || 100,
                    date: date || Date.now(),
                    academicYear: activeYear._id,
                    createdBy: req.user.userId,
                    instructions,
                    duration
                });
                await exam.save();
                results.push({ type, status: 'created', exam });
            } else {
                results.push({ type, status: 'exists', exam });
            }
        }

        if (results.some(r => r.status === 'created')) {
            await sendTargetedNotification('class', classId, {
                title: 'New Exams Scheduled',
                message: `New exams have been scheduled for ${subject.name}. Check your schedule.`,
                type: 'Exam'
            });
        }

        res.json(results);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/exams/school-wide/init
// @desc    Initialize a specific standardized exam for ALL classes or SELECTED classes
// @access  Private (Admin/Super Admin)
router.post('/school-wide/init', auth, async (req, res) => {
    try {
        const { type, totalMarks, date, instructions, duration, classIds, subjectMarks, excludedSubjectIds } = req.body;

        const userRole = req.user.role;
        if (userRole !== 'admin' && userRole !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized. Only Admins can perform school-wide initialization.' });
        }

        if (!['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'].includes(type)) {
            return res.status(400).json({ message: 'Invalid exam type. Must be one of: FA1, FA2, SA1, FA3, FA4, SA2' });
        }

        const activeYear = await AcademicYear.findOne({ isActive: true }).lean();

        if (!activeYear) {
            return res.status(404).json({ message: 'No active academic year found' });
        }

        const examNames = {
            'FA1': 'Formative Assessment 1',
            'FA2': 'Formative Assessment 2',
            'SA1': 'Summative Assessment 1',
            'FA3': 'Formative Assessment 3',
            'FA4': 'Formative Assessment 4',
            'SA2': 'Summative Assessment 2'
        };

        let classQuery = {};
        if (classIds && Array.isArray(classIds) && classIds.length > 0) {
            classQuery = { _id: { $in: classIds } };
        }

        const [classes, allSubjects] = await Promise.all([
            Class.find(classQuery).lean(),
            Subject.find().lean()
        ]);

        if (classes.length === 0) {
            return res.status(404).json({ message: 'No classes found to initialize exams for.' });
        }

        const existingExams = await Exam.find({
            academicYear: activeYear._id,
            standardizedType: type,
            isStandardized: true
        }).select('class subject').lean();

        const existingExamSet = new Set(
            existingExams.map(e => `${e.class.toString()}-${e.subject.toString()}`)
        );

        const newExams = [];
        let skippedCount = 0;
        const globalDefault = totalMarks || 100;
        const excludedSet = new Set((Array.isArray(excludedSubjectIds) ? excludedSubjectIds : []).map(String));

        for (const cls of classes) {
            const classSubjects = allSubjects.filter(s => s.class.toString() === cls._id.toString());
            for (const subject of classSubjects) {
                if (excludedSet.has(subject._id.toString())) {
                    skippedCount++;
                    continue;
                }
                const key = `${cls._id.toString()}-${subject._id.toString()}`;
                if (!existingExamSet.has(key)) {
                    const subjectSpecificMarks = subjectMarks && subjectMarks[subject._id.toString()]
                        ? Number(subjectMarks[subject._id.toString()])
                        : globalDefault;

                    newExams.push({
                        name: examNames[type],
                        type: type === 'SA2' ? 'final' : (type.startsWith('SA') ? 'mid-term' : 'unit-test'),
                        isStandardized: true,
                        standardizedType: type,
                        class: cls._id,
                        subject: subject._id,
                        totalMarks: subjectSpecificMarks,
                        date: date || Date.now(),
                        academicYear: activeYear._id,
                        createdBy: req.user.userId,
                        instructions,
                        duration
                    });
                } else {
                    skippedCount++;
                }
            }
        }

        if (newExams.length === 0 && skippedCount > 0) {
            return res.status(400).json({ message: 'Exams of this type have already been initialized for the selected scopes.' });
        }

        if (newExams.length > 0) {
            await Exam.insertMany(newExams);
            const affectedClassIds = [...new Set(newExams.map(e => e.class.toString()))];

            for (const cId of affectedClassIds) {
                await sendTargetedNotification('class', cId, {
                    title: `Exam Scheduled: ${type}`,
                    message: `${examNames[type]} has been scheduled for your class.`,
                    type: 'Exam'
                });
            }
        }

        res.json({
            message: `Initialization complete for ${type}`,
            created: newExams.length,
            skipped: skippedCount,
            totalProcessed: newExams.length + skippedCount,
            targetClasses: classes.length
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/exams
// @desc    Create new exam (DEPRECATED)
router.post('/', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (user.role !== 'admin' && user.role !== 'super admin') {
            return res.status(403).json({
                message: 'This endpoint is deprecated. Please use /api/exams/standardized'
            });
        }
        const { name, type, classId, subjectId, totalMarks, date, instructions, duration, room } = req.body;
        const activeYear = await AcademicYear.findOne({ isActive: true });
        const exam = new Exam({
            name, type, class: classId, subject: subjectId, totalMarks,
            date: date || Date.now(), academicYear: activeYear ? activeYear._id : null,
            createdBy: req.user.userId, instructions, duration, room, isStandardized: false
        });
        await exam.save();
        res.json(await Exam.findById(exam._id).populate('class subject createdBy'));
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/subject/:subjectId
router.get('/subject/:subjectId', auth, async (req, res) => {
    try {
        const exams = await Exam.find({ subject: req.params.subjectId, isStandardized: true })
            .populate('class subject createdBy').sort({ date: -1 }).lean();
        res.json(exams);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/:id
router.get('/:id', auth, async (req, res) => {
    try {
        if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) return res.status(404).json({ msg: 'Invalid exam ID format' });
        const exam = await Exam.findById(req.params.id).populate('class subject createdBy academicYear').lean();
        if (!exam) return res.status(404).json({ message: 'Exam not found' });
        res.json(exam);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/exams/:id
router.put('/:id', auth, async (req, res) => {
    try {
        let exam = await Exam.findById(req.params.id);
        if (!exam) return res.status(404).json({ message: 'Exam not found' });
        const updater = await User.findById(req.user.userId);
        if (exam.createdBy.toString() !== req.user.userId && updater.role !== 'admin' && updater.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }
        const { totalMarks, date, instructions, duration } = req.body;
        if (totalMarks) exam.totalMarks = totalMarks;
        if (date) exam.date = date;
        if (instructions !== undefined) exam.instructions = instructions;
        if (duration) exam.duration = duration;
        await exam.save();
        res.json(await Exam.findById(exam._id).populate('class subject createdBy'));
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/exams/:id
router.delete('/:id', auth, async (req, res) => {
    try {
        const exam = await Exam.findById(req.params.id);
        if (!exam) return res.status(404).json({ message: 'Exam not found' });
        const user = await User.findById(req.user.userId);
        if (exam.createdBy.toString() !== req.user.userId && user.role !== 'admin' && user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }
        await Marks.deleteMany({ exam: req.params.id });
        await Exam.findByIdAndDelete(req.params.id);
        res.json({ message: 'Exam and associated marks deleted' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/schedule/student
router.get('/schedule/student', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (!user || user.role !== 'student') return res.status(403).json({ message: 'Not authorized' });
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const exams = await Exam.find({ class: user.currentClass, date: { $gte: today }, isStandardized: true })
            .populate('subject class').sort({ date: 1 }).lean();
        res.json(exams);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/schedule/class/:classId
router.get('/schedule/class/:classId', auth, async (req, res) => {
    try {
        const exams = await Exam.find({ class: req.params.classId, isStandardized: true })
            .populate('subject createdBy').sort({ date: 1 }).lean();
        res.json(exams);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/history
router.get('/history', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        let query = { date: { $lt: today }, isStandardized: true };
        if (user.role === 'teacher' || user.role === 'staff') query.createdBy = req.user.userId;
        const exams = await Exam.find(query).populate('class subject createdBy').sort({ date: -1 }).lean();
        res.json(exams);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/performance/class/:classId
router.get('/performance/class/:classId', auth, async (req, res) => {
    try {
        const { academicYearId } = req.query;
        let yearId = academicYearId;
        if (!yearId) {
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }
        const exams = await Exam.find({ class: req.params.classId, academicYear: yearId, isStandardized: true }).populate('subject').lean();
        const students = await User.find({ currentClass: req.params.classId, role: 'student' }).select('name').lean();
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({ exam: { $in: examIds } }).lean();

        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const performance = examTypes.map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);
            const examIdsForType = typeExams.map(e => e._id.toString());
            const marksForType = allMarks.filter(m => examIdsForType.includes(m.exam.toString()));
            let totalMarks = 0, obtainedMarks = 0;
            let studentsWithMarks = new Set();
            const studentMarks = {};
            marksForType.forEach(mark => {
                const exam = typeExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalMarks += exam.totalMarks;
                    obtainedMarks += mark.marksObtained;
                    const studentId = mark.student.toString();
                    studentsWithMarks.add(studentId);
                    if (!studentMarks[studentId]) {
                        studentMarks[studentId] = { obtained: 0, total: 0 };
                    }
                    studentMarks[studentId].obtained += mark.marksObtained;
                    studentMarks[studentId].total += exam.totalMarks;
                }
            });
            const avgPercentage = totalMarks > 0 ? ((obtainedMarks / totalMarks) * 100).toFixed(2) : 0;
            
            const percentages = Object.values(studentMarks).map(sm => sm.total > 0 ? (sm.obtained / sm.total) * 100 : 0);
            const highest = percentages.length > 0 ? Math.max(...percentages) : 0;
            const lowest = percentages.length > 0 ? Math.min(...percentages) : 0;

            return {
                examType: type,
                subjectsCount: typeExams.length,
                studentsWithMarks: studentsWithMarks.size,
                totalStudents: students.length,
                avgPercentage: parseFloat(avgPercentage),
                highest: parseFloat(highest.toFixed(2)),
                lowest: parseFloat(lowest.toFixed(2)),
                isComplete: typeExams.length > 0 && studentsWithMarks.size === students.length
            };
        });
        res.json({ classId: req.params.classId, totalStudents: students.length, performance });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/performance/subject/:subjectId
router.get('/performance/subject/:subjectId', auth, async (req, res) => {
    try {
        const { academicYearId, classId } = req.query;
        let yearId = academicYearId;
        if (!yearId) {
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }
        let examQuery = { subject: req.params.subjectId, academicYear: yearId, isStandardized: true };
        if (classId) examQuery.class = classId;
        const exams = await Exam.find(examQuery).populate('class', 'name section').lean();
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({ exam: { $in: examIds } }).lean();

        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const performance = examTypes.map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);
            const classwiseData = typeExams.map(exam => {
                const marksForExam = allMarks.filter(m => m.exam.toString() === exam._id.toString());
                let totalObtained = 0;
                const percentages = [];
                marksForExam.forEach(m => {
                    totalObtained += m.marksObtained;
                    if (exam.totalMarks > 0) {
                        percentages.push((m.marksObtained / exam.totalMarks) * 100);
                    }
                });
                const highest = percentages.length > 0 ? Math.max(...percentages) : 0;
                const lowest = percentages.length > 0 ? Math.min(...percentages) : 0;
                const avgPercentage = marksForExam.length > 0 ? ((totalObtained / (exam.totalMarks * marksForExam.length)) * 100).toFixed(2) : 0;
                return { 
                    classId: exam.class._id, 
                    className: `${exam.class.name} ${exam.class.section || ''}`, 
                    studentsCount: marksForExam.length,
                    avgPercentage: parseFloat(avgPercentage),
                    highest: parseFloat(highest.toFixed(2)),
                    lowest: parseFloat(lowest.toFixed(2))
                };
            });
            let overallTotal = 0, overallObtained = 0;
            typeExams.forEach(exam => {
                const marksForExam = allMarks.filter(m => m.exam.toString() === exam._id.toString());
                marksForExam.forEach(m => { overallTotal += exam.totalMarks; overallObtained += m.marksObtained; });
            });
            const overallAvg = overallTotal > 0 ? ((overallObtained / overallTotal) * 100).toFixed(2) : 0;
            return { examType: type, overallAvgPercentage: parseFloat(overallAvg), classwiseData };
        });
        res.json({ subjectId: req.params.subjectId, performance });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


// @route   GET /api/exams/performance/school
router.get('/performance/school', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId);
        if (user.role !== 'admin' && user.role !== 'super admin') return res.status(403).json({ message: 'Not authorized' });
        const { academicYearId } = req.query;
        let yearId = academicYearId;
        if (!yearId) {
            const activeYear = await AcademicYear.findOne({ isActive: true });
            if (activeYear) yearId = activeYear._id;
        }
        const exams = await Exam.find({ academicYear: yearId, isStandardized: true }).populate('class subject').lean();
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({ exam: { $in: examIds } }).lean();

        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const schoolPerformance = examTypes.map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);
            const examIdsForType = typeExams.map(e => e._id.toString());
            const marksForType = allMarks.filter(m => examIdsForType.includes(m.exam.toString()));
            let totalMarks = 0, obtainedMarks = 0;
            marksForType.forEach(mark => {
                const exam = typeExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) { totalMarks += exam.totalMarks; obtainedMarks += mark.marksObtained; }
            });
            const avgPercentage = totalMarks > 0 ? ((obtainedMarks / totalMarks) * 100).toFixed(2) : 0;
            return { examType: type, examsCount: typeExams.length, marksEntered: marksForType.length, avgPercentage: parseFloat(avgPercentage) };
        });

        const classes = await Class.find().lean();
        const classwiseSummary = classes.map(cls => {
            const classExams = exams.filter(e => e.class._id.toString() === cls._id.toString());
            const marks = allMarks.filter(m => classExams.some(e => e._id.toString() === m.exam.toString()));
            let total = 0, obtained = 0;
            marks.forEach(mark => {
                const exam = classExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) { total += exam.totalMarks; obtained += mark.marksObtained; }
            });

            // Per-exam-type breakdown for this class
            const examTypeBreakdown = examTypes.map(type => {
                const typeExams = classExams.filter(e => e.standardizedType === type);
                const typeMarks = allMarks.filter(m => typeExams.some(e => e._id.toString() === m.exam.toString()));
                let tTotal = 0, tObtained = 0;
                typeMarks.forEach(mark => {
                    const exam = typeExams.find(e => e._id.toString() === mark.exam.toString());
                    if (exam) { tTotal += exam.totalMarks; tObtained += mark.marksObtained; }
                });
                return {
                    examType: type,
                    avgPercentage: tTotal > 0 ? parseFloat(((tObtained / tTotal) * 100).toFixed(2)) : null,
                    marksEntered: typeMarks.length,
                    examsCount: typeExams.length
                };
            }).filter(b => b.examsCount > 0);

            return {
                classId: cls._id,
                className: `${cls.name} ${cls.section || ''}`,
                avgPercentage: total > 0 ? parseFloat(((obtained / total) * 100).toFixed(2)) : 0,
                examsCount: classExams.length,
                examTypeBreakdown
            };
        });

        const subjectNameMap = new Map();
        exams.forEach(exam => {
            const name = exam.subject.name.trim();
            const marks = allMarks.filter(m => m.exam.toString() === exam._id.toString());
            if (!subjectNameMap.has(name)) subjectNameMap.set(name, { total: 0, obtained: 0, count: 0, examsByType: {} });
            const s = subjectNameMap.get(name);
            s.total += exam.totalMarks * marks.length;
            marks.forEach(m => s.obtained += m.marksObtained);
            s.count += 1;

            // Group by exam type for breakdown
            const type = exam.standardizedType;
            if (!s.examsByType[type]) s.examsByType[type] = { total: 0, obtained: 0, count: 0 };
            const t = s.examsByType[type];
            t.total += exam.totalMarks * marks.length;
            marks.forEach(m => t.obtained += m.marksObtained);
            t.count += 1;
        });

        const subjectwiseSummary = Array.from(subjectNameMap.entries()).map(([name, s]) => {
            const examTypeBreakdown = examTypes.map(type => {
                const t = s.examsByType[type];
                if (!t || t.count === 0) return null;
                return {
                    examType: type,
                    avgPercentage: t.total > 0 ? parseFloat(((t.obtained / t.total) * 100).toFixed(2)) : null,
                    examsCount: t.count
                };
            }).filter(Boolean);

            return {
                subjectName: name,
                avgPercentage: s.total > 0 ? parseFloat(((s.obtained / s.total) * 100).toFixed(2)) : 0,
                examsCount: s.count,
                examTypeBreakdown
            };
        });

        res.json({ examwisePerformance: schoolPerformance, classwiseSummary, subjectwiseSummary });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/exams/:id/subject/:subjectId
router.delete('/:id/subject/:subjectId', auth, async (req, res) => {
    try {
        const { id: examId, subjectId } = req.params;
        const exam = await Exam.findById(examId);
        if (!exam) return res.status(404).json({ message: 'Exam not found' });
        const user = await User.findById(req.user.userId);
        if (exam.createdBy.toString() !== req.user.userId && user.role !== 'admin' && user.role !== 'super admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }
        const deletedMarks = await Marks.deleteMany({ exam: examId, subject: subjectId });
        res.json({ message: 'Subject removed from exam. Associated marks deleted.', deletedMarksCount: deletedMarks.deletedCount });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/exams/quick-init
router.post('/quick-init', [auth, yearContext, requireOpenYear], async (req, res) => {
    try {
        const { classId, subjectId, examsConfig, types: requestedTypes } = req.body;
        const academicYearId = req.academicYearContext;
        const subject = await Subject.findById(subjectId).populate('class');
        const isAdmin = req.user.role === 'admin' || req.user.role === 'super admin';
        const isSubjectTeacher = subject.teachers.includes(req.user.userId);
        const isClassTeacher = subject.class && subject.class.classTeacher && subject.class.classTeacher.toString() === req.user.userId.toString();
        if (!isAdmin && !isSubjectTeacher && !isClassTeacher) return res.status(403).json({ message: 'Not authorized' });
        const examTypes = (Array.isArray(requestedTypes) && requestedTypes.length > 0) ? requestedTypes : ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const results = [];
        for (const type of examTypes) {
            let exam = await Exam.findOne({ class: classId, subject: subjectId, academicYear: academicYearId, standardizedType: type, isStandardized: true });
            if (!exam) {
                const config = examsConfig[type] || {};
                exam = new Exam({
                    name: type, type: type === 'SA2' ? 'final' : (type.startsWith('SA') ? 'mid-term' : 'unit-test'),
                    isStandardized: true, standardizedType: type, class: classId, subject: subjectId,
                    totalMarks: config.totalMarks || examsConfig.totalMarks || 100,
                    date: config.date || examsConfig.defaultDate || Date.now(),
                    academicYear: academicYearId, createdBy: req.user.userId
                });
                await exam.save(); results.push({ type, status: 'created', exam });
            } else results.push({ type, status: 'exists', exam });
        }
        res.json({ message: 'Quick initialization complete', results });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/teacher/dashboard
router.get('/teacher/dashboard', [auth, yearContext], async (req, res) => {
    try {
        const academicYearId = req.academicYearContext;
        
        // Find classes where the user is a class teacher
        const classesAsClassTeacher = await Class.find({ classTeacher: req.user.userId }).distinct('_id');

        // Find subjects where user is subject teacher OR class teacher
        const subjects = await Subject.find({
            $or: [
                { teachers: req.user.userId },
                { class: { $in: classesAsClassTeacher } }
            ]
        }).populate('class', 'name section').lean();

        const dashboard = [];
        for (const subject of subjects) {
            const exams = await Exam.find({ class: subject.class._id, subject: subject._id, academicYear: academicYearId, isStandardized: true }).lean();
            const studentCount = await User.countDocuments({ currentClass: subject.class._id, role: 'student' });
            
            const examIds = exams.map(e => e._id);
            const marksCounts = await Marks.aggregate([
                { $match: { exam: { $in: examIds } } },
                { $group: { _id: '$exam', count: { $sum: 1 } } }
            ]);
            const marksMap = {};
            marksCounts.forEach(m => marksMap[m._id.toString()] = m.count);

            let examsCreated = exams.length;
            let marksEntered = 0;
            let marksPublished = 0;

            const examStatus = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'].map(type => {
                const exam = exams.find(e => e.standardizedType === type);
                let marksComplete = false;
                if (exam) {
                    const count = marksMap[exam._id.toString()] || 0;
                    marksComplete = count > 0;
                    if (marksComplete) marksEntered++;
                    if (exam.marksPublished) marksPublished++;
                }
                return { 
                    type, 
                    exists: !!exam, 
                    examId: exam?._id, 
                    status: exam?.status || null,
                    marksComplete,
                    marksPublished: exam?.marksPublished || false
                };
            });
            
            let pending = examsCreated - marksEntered; // exams that don't have marks entered

            dashboard.push({ 
                classId: subject.class._id,
                subjectId: subject._id,
                className: `${subject.class.name} ${subject.class.section || ''}`, 
                subjectName: subject.name, 
                studentCount, 
                examStatus,
                summary: { examsCreated, marksEntered, marksPublished, pending }
            });
        }
        res.json({ dashboard });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/exams/status-summary
router.get('/status-summary', [auth, yearContext], async (req, res) => {
    try {
        const query = { academicYear: req.academicYearContext, isStandardized: true };
        const [counts, total] = await Promise.all([
            Exam.aggregate([{ $match: query }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
            Exam.countDocuments(query)
        ]);
        const byStatus = {}; counts.forEach(c => byStatus[c._id] = c.count);
        res.json({ total, byStatus });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/exams/bulk-update
router.put('/bulk-update', [auth, yearContext, requireOpenYear], async (req, res) => {
    try {
        const { examIds, updates } = req.body;
        const result = await Exam.updateMany({ _id: { $in: examIds } }, { $set: updates });
        res.json({ message: 'Bulk update completed', modifiedCount: result.modifiedCount });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/exams/:id/publish-marks
router.post('/:id/publish-marks', [auth, yearContext, requireOpenYear], async (req, res) => {
    try {
        const exam = await Exam.findById(req.params.id);
        if (!exam) return res.status(404).json({ message: 'Exam not found' });
        exam.marksPublished = true; await exam.save();
        res.json({ message: 'Marks published successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
