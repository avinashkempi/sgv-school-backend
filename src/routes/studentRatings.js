const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { validationResult } = require('express-validator');
const { authenticateToken: auth, requireAdmin } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');
const StudentRating = require('../models/StudentRating');
const Subject = require('../models/Subject');
const User = require('../models/User');
const { bulkRatingValidation } = require('../validations/studentRating');

const hasObjectIdMatch = (ids = [], userId) => ids.some((id) => id && id.toString() === userId);

// ──────────────────────────────────────────────
//  TEACHER ENDPOINTS
// ──────────────────────────────────────────────

// @route   GET /api/student-ratings/my-subjects
// @desc    Get teacher's subjects with rating submission status for a given month
// @access  Private (Teacher/Admin)
router.get('/my-subjects', [auth, yearContext], async (req, res) => {
    try {
        const userId = req.user.userId;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        // Get all subjects this teacher teaches in the current academic year
        let subjects = await Subject.find({
            teachers: userId,
            academicYear: req.academicYearContext
        })
            .populate('class', 'value label name section branch')
            .sort({ name: 1 });

        // Filter out subjects where class population failed
        subjects = subjects.filter(s => s.class);

        if (subjects.length === 0) {
            return res.json({
                success: true,
                month,
                year,
                subjects: [],
                summary: { total: 0, completed: 0, pending: 0 }
            });
        }

        // Check which subjects already have ratings submitted for this month
        const subjectIds = subjects.map(s => s._id);
        const existingRatings = await StudentRating.aggregate([
            {
                $match: {
                    teacher: new mongoose.Types.ObjectId(userId),
                    subject: { $in: subjectIds },
                    month,
                    year,
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                }
            },
            {
                $group: {
                    _id: '$subject',
                    count: { $sum: 1 }
                }
            }
        ]);

        const ratingCountMap = {};
        existingRatings.forEach(r => {
            ratingCountMap[r._id.toString()] = r.count;
        });

        // Get student counts per class for completion status
        const classIds = [...new Set(subjects.map(s => s.class._id.toString()))];
        const studentCounts = await User.aggregate([
            {
                $match: {
                    role: 'student',
                    currentClass: { $in: classIds.map(id => new mongoose.Types.ObjectId(id)) },
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
                    isActive: true
                }
            },
            {
                $group: {
                    _id: '$currentClass',
                    count: { $sum: 1 }
                }
            }
        ]);

        const studentCountMap = {};
        studentCounts.forEach(sc => {
            studentCountMap[sc._id.toString()] = sc.count;
        });

        // Build response
        const subjectsWithStatus = subjects.map(subject => {
            const classId = subject.class._id.toString();
            const totalStudents = studentCountMap[classId] || 0;
            const ratedCount = ratingCountMap[subject._id.toString()] || 0;
            const isCompleted = totalStudents > 0 && ratedCount >= totalStudents;

            return {
                _id: subject._id,
                name: subject.name,
                class: subject.class,
                totalStudents,
                ratedCount,
                status: isCompleted ? 'submitted' : 'pending'
            };
        });

        const completed = subjectsWithStatus.filter(s => s.status === 'submitted').length;

        res.json({
            success: true,
            month,
            year,
            subjects: subjectsWithStatus,
            summary: {
                total: subjectsWithStatus.length,
                completed,
                pending: subjectsWithStatus.length - completed
            }
        });
    } catch (err) {
        console.error('Error fetching teacher subjects for ratings:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/student-ratings/subject/:subjectId
// @desc    Get existing ratings for a subject for a given month (for edit/review by teacher)
// @access  Private (Teacher/Admin)
router.get('/subject/:subjectId', [auth, yearContext], async (req, res) => {
    try {
        const { subjectId } = req.params;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const userId = req.user.userId;
        const userRole = req.user.role;

        // Validate subject exists and teacher has access
        const subject = await Subject.findById(subjectId)
            .populate('class', 'value label name section branch');

        if (!subject) {
            return res.status(404).json({ success: false, message: 'Subject not found' });
        }

        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isSubjectTeacher = hasObjectIdMatch(subject.teachers, userId);

        if (!isAdmin && !isSubjectTeacher) {
            return res.status(403).json({ success: false, message: 'Not authorized to view ratings for this subject' });
        }

        // Get all students in this class
        const students = await User.find({
            currentClass: subject.class._id,
            role: 'student',
            academicYear: req.academicYearContext,
            isActive: true
        })
            .select('name phone gender regNo')
            .sort({ name: 1 })
            .lean();

        // Get existing ratings for these students
        const existingRatings = await StudentRating.find({
            subject: subjectId,
            month,
            year,
            academicYear: req.academicYearContext
        })
            .select('student classEngagement homeworkClasswork behaviourSocial englishComm averageScore')
            .lean();

        const ratingMap = {};
        existingRatings.forEach(r => {
            ratingMap[r.student.toString()] = {
                classEngagement: r.classEngagement,
                homeworkClasswork: r.homeworkClasswork,
                behaviourSocial: r.behaviourSocial,
                englishComm: r.englishComm,
                averageScore: r.averageScore
            };
        });

        // Merge students with their ratings (if any)
        const studentsWithRatings = students.map(student => ({
            _id: student._id,
            name: student.name,
            gender: student.gender,
            regNo: student.regNo,
            rating: ratingMap[student._id.toString()] || null
        }));

        res.json({
            success: true,
            subject: {
                _id: subject._id,
                name: subject.name,
                class: subject.class
            },
            month,
            year,
            students: studentsWithRatings,
            totalStudents: students.length,
            ratedCount: existingRatings.length,
            dataPoints: StudentRating.DATA_POINTS,
            ratingLabels: StudentRating.RATING_LABELS
        });
    } catch (err) {
        console.error('Error fetching subject ratings:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   POST /api/student-ratings/bulk
// @desc    Submit ratings for all students in a subject for a given month
// @access  Private (Teacher/Admin)
router.post('/bulk', [auth, yearContext, requireOpenYear, ...bulkRatingValidation], async (req, res) => {
    try {
        // Check validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: errors.array()
            });
        }

        const { subjectId, month, year, ratings } = req.body;
        const userId = req.user.userId;
        const userRole = req.user.role;

        // Validate subject exists and teacher has access
        const subject = await Subject.findById(subjectId)
            .populate('class', '_id value label');

        if (!subject) {
            return res.status(404).json({ success: false, message: 'Subject not found' });
        }

        const isAdmin = userRole === 'admin' || userRole === 'super admin';
        const isSubjectTeacher = hasObjectIdMatch(subject.teachers, userId);

        if (!isAdmin && !isSubjectTeacher) {
            return res.status(403).json({ success: false, message: 'Not authorized to rate students for this subject' });
        }

        // Validate all student IDs belong to this class
        const studentIds = ratings.map(r => new mongoose.Types.ObjectId(r.studentId));
        const validStudents = await User.find({
            _id: { $in: studentIds },
            currentClass: subject.class._id,
            role: 'student',
            academicYear: req.academicYearContext,
            isActive: true
        }).select('_id').lean();

        const validStudentIdSet = new Set(validStudents.map(s => s._id.toString()));
        const invalidStudents = ratings.filter(r => !validStudentIdSet.has(r.studentId));

        if (invalidStudents.length > 0) {
            return res.status(400).json({
                success: false,
                message: `${invalidStudents.length} student(s) do not belong to this class or are inactive`
            });
        }

        // Upsert ratings (insert or update)
        const bulkOps = ratings.map(r => {
            const avg = parseFloat(
                ((r.classEngagement + r.homeworkClasswork + r.behaviourSocial + r.englishComm) / 4).toFixed(2)
            );

            return {
                updateOne: {
                    filter: {
                        student: new mongoose.Types.ObjectId(r.studentId),
                        subject: new mongoose.Types.ObjectId(subjectId),
                        month,
                        year,
                        academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                    },
                    update: {
                        $set: {
                            class: subject.class._id,
                            teacher: new mongoose.Types.ObjectId(userId),
                            classEngagement: r.classEngagement,
                            homeworkClasswork: r.homeworkClasswork,
                            behaviourSocial: r.behaviourSocial,
                            englishComm: r.englishComm,
                            averageScore: avg,
                            updatedAt: new Date()
                        },
                        $setOnInsert: {
                            submittedAt: new Date()
                        }
                    },
                    upsert: true
                }
            };
        });

        const result = await StudentRating.bulkWrite(bulkOps, { ordered: false });

        res.json({
            success: true,
            message: `Ratings submitted successfully for ${ratings.length} student(s)`,
            stats: {
                inserted: result.upsertedCount || 0,
                updated: result.modifiedCount || 0,
                total: ratings.length
            }
        });
    } catch (err) {
        // Handle duplicate key errors gracefully
        if (err.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'Duplicate rating entry detected. Ratings may have already been submitted.'
            });
        }
        console.error('Error submitting bulk ratings:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ──────────────────────────────────────────────
//  ADMIN / ANALYTICS ENDPOINTS (Phase 3 — stubs)
// ──────────────────────────────────────────────

// @route   GET /api/student-ratings/class/:classId/summary
// @desc    Get class average and per-student averages for a given month
// @access  Private (Admin)
router.get('/class/:classId/summary', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        const { classId } = req.params;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const ratings = await StudentRating.find({
            class: classId,
            month,
            year,
            academicYear: req.academicYearContext
        })
            .populate('student', 'name gender regNo')
            .populate('subject', 'name')
            .lean();

        if (ratings.length === 0) {
            return res.json({
                success: true,
                month,
                year,
                classAverage: null,
                students: [],
                message: 'No ratings found for this class in the selected month'
            });
        }

        // Group by student
        const studentMap = {};
        ratings.forEach(r => {
            const sid = r.student._id.toString();
            if (!studentMap[sid]) {
                studentMap[sid] = {
                    student: r.student,
                    subjects: [],
                    totalAvg: 0,
                    count: 0
                };
            }
            studentMap[sid].subjects.push({
                subject: r.subject,
                classEngagement: r.classEngagement,
                homeworkClasswork: r.homeworkClasswork,
                behaviourSocial: r.behaviourSocial,
                englishComm: r.englishComm,
                averageScore: r.averageScore
            });
            studentMap[sid].totalAvg += r.averageScore;
            studentMap[sid].count += 1;
        });

        const students = Object.values(studentMap).map(s => ({
            student: s.student,
            overallAverage: parseFloat((s.totalAvg / s.count).toFixed(2)),
            subjectCount: s.count,
            subjects: s.subjects
        }));

        // Sort by overall average descending
        students.sort((a, b) => b.overallAverage - a.overallAverage);

        // Class-level averages
        const allAvgs = students.map(s => s.overallAverage);
        const classAverage = parseFloat((allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length).toFixed(2));

        res.json({
            success: true,
            month,
            year,
            classAverage,
            totalStudents: students.length,
            students,
            dataPoints: StudentRating.DATA_POINTS,
            ratingLabels: StudentRating.RATING_LABELS
        });
    } catch (err) {
        console.error('Error fetching class rating summary:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/student-ratings/student/:studentId/trend
// @desc    Get monthly trend for a student (last N months)
// @access  Private (Admin/Teacher)
router.get('/student/:studentId/trend', [auth, yearContext], async (req, res) => {
    try {
        const { studentId } = req.params;
        const months = parseInt(req.query.months) || 6;

        const ratings = await StudentRating.find({
            student: studentId,
            academicYear: req.academicYearContext
        })
            .populate('subject', 'name')
            .sort({ year: 1, month: 1 })
            .lean();

        if (ratings.length === 0) {
            return res.json({
                success: true,
                studentId,
                trend: [],
                message: 'No ratings found for this student'
            });
        }

        // Group by month-year
        const monthMap = {};
        ratings.forEach(r => {
            const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
            if (!monthMap[key]) {
                monthMap[key] = {
                    month: r.month,
                    year: r.year,
                    label: key,
                    scores: [],
                    subjectBreakdown: []
                };
            }
            monthMap[key].scores.push(r.averageScore);
            monthMap[key].subjectBreakdown.push({
                subject: r.subject,
                classEngagement: r.classEngagement,
                homeworkClasswork: r.homeworkClasswork,
                behaviourSocial: r.behaviourSocial,
                englishComm: r.englishComm,
                averageScore: r.averageScore
            });
        });

        // Compute monthly averages and sort
        let trend = Object.values(monthMap)
            .map(m => ({
                month: m.month,
                year: m.year,
                label: m.label,
                overallAverage: parseFloat((m.scores.reduce((a, b) => a + b, 0) / m.scores.length).toFixed(2)),
                subjectCount: m.scores.length,
                subjectBreakdown: m.subjectBreakdown
            }))
            .sort((a, b) => a.label.localeCompare(b.label));

        // Limit to last N months
        if (trend.length > months) {
            trend = trend.slice(-months);
        }

        // Compute trend direction
        let trendDirection = 'stable';
        if (trend.length >= 2) {
            const latest = trend[trend.length - 1].overallAverage;
            const previous = trend[trend.length - 2].overallAverage;
            if (latest > previous + 0.25) trendDirection = 'improving';
            else if (latest < previous - 0.25) trendDirection = 'declining';
        }

        res.json({
            success: true,
            studentId,
            trendDirection,
            trend,
            dataPoints: StudentRating.DATA_POINTS,
            ratingLabels: StudentRating.RATING_LABELS
        });
    } catch (err) {
        console.error('Error fetching student rating trend:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/student-ratings/student/:studentId/details
// @desc    Get full subject-wise breakdown for a student for a given month
// @access  Private (Admin/Teacher)
router.get('/student/:studentId/details', [auth, yearContext], async (req, res) => {
    try {
        const { studentId } = req.params;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const student = await User.findById(studentId).select('name gender regNo currentClass').lean();
        if (!student) {
            return res.status(404).json({ success: false, message: 'Student not found' });
        }

        const ratings = await StudentRating.find({
            student: studentId,
            month,
            year,
            academicYear: req.academicYearContext
        })
            .populate('subject', 'name')
            .populate('teacher', 'name')
            .lean();

        // Compute overall averages per data point
        let avgEngagement = 0, avgHomework = 0, avgBehaviour = 0, avgEnglish = 0;
        if (ratings.length > 0) {
            avgEngagement = parseFloat((ratings.reduce((s, r) => s + r.classEngagement, 0) / ratings.length).toFixed(2));
            avgHomework = parseFloat((ratings.reduce((s, r) => s + r.homeworkClasswork, 0) / ratings.length).toFixed(2));
            avgBehaviour = parseFloat((ratings.reduce((s, r) => s + r.behaviourSocial, 0) / ratings.length).toFixed(2));
            avgEnglish = parseFloat((ratings.reduce((s, r) => s + r.englishComm, 0) / ratings.length).toFixed(2));
        }

        const overallAverage = ratings.length > 0
            ? parseFloat((ratings.reduce((s, r) => s + r.averageScore, 0) / ratings.length).toFixed(2))
            : null;

        res.json({
            success: true,
            student,
            month,
            year,
            overallAverage,
            dataPointAverages: {
                classEngagement: avgEngagement,
                homeworkClasswork: avgHomework,
                behaviourSocial: avgBehaviour,
                englishComm: avgEnglish
            },
            subjectRatings: ratings.map(r => ({
                subject: r.subject,
                teacher: r.teacher,
                classEngagement: r.classEngagement,
                homeworkClasswork: r.homeworkClasswork,
                behaviourSocial: r.behaviourSocial,
                englishComm: r.englishComm,
                averageScore: r.averageScore
            })),
            dataPoints: StudentRating.DATA_POINTS,
            ratingLabels: StudentRating.RATING_LABELS
        });
    } catch (err) {
        console.error('Error fetching student rating details:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/student-ratings/school/summary
// @desc    Get school-wide summary — class averages comparison
// @access  Private (Admin)
router.get('/school/summary', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const classAverages = await StudentRating.aggregate([
            {
                $match: {
                    month,
                    year,
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                }
            },
            {
                $group: {
                    _id: '$class',
                    avgClassEngagement: { $avg: '$classEngagement' },
                    avgHomeworkClasswork: { $avg: '$homeworkClasswork' },
                    avgBehaviourSocial: { $avg: '$behaviourSocial' },
                    avgEnglishComm: { $avg: '$englishComm' },
                    avgOverall: { $avg: '$averageScore' },
                    totalRatings: { $sum: 1 },
                    uniqueStudents: { $addToSet: '$student' }
                }
            },
            {
                $lookup: {
                    from: 'classes',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'classInfo'
                }
            },
            { $unwind: '$classInfo' },
            {
                $project: {
                    class: {
                        _id: '$classInfo._id',
                        value: '$classInfo.value',
                        label: '$classInfo.label',
                        section: '$classInfo.section',
                        branch: '$classInfo.branch'
                    },
                    avgClassEngagement: { $round: ['$avgClassEngagement', 2] },
                    avgHomeworkClasswork: { $round: ['$avgHomeworkClasswork', 2] },
                    avgBehaviourSocial: { $round: ['$avgBehaviourSocial', 2] },
                    avgEnglishComm: { $round: ['$avgEnglishComm', 2] },
                    avgOverall: { $round: ['$avgOverall', 2] },
                    totalRatings: 1,
                    studentCount: { $size: '$uniqueStudents' }
                }
            },
            { $sort: { 'class.value': 1, 'class.section': 1 } }
        ]);

        // School-wide average
        const schoolAverage = classAverages.length > 0
            ? parseFloat((classAverages.reduce((s, c) => s + c.avgOverall, 0) / classAverages.length).toFixed(2))
            : null;

        res.json({
            success: true,
            month,
            year,
            schoolAverage,
            totalClasses: classAverages.length,
            classes: classAverages,
            dataPoints: StudentRating.DATA_POINTS,
            ratingLabels: StudentRating.RATING_LABELS
        });
    } catch (err) {
        console.error('Error fetching school rating summary:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/student-ratings/school/movers
// @desc    Get students who are improving or declining compared to previous month
// @access  Private (Admin)
router.get('/school/movers', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const classId = req.query.classId; // Optional class filter

        // Calculate previous month
        let prevMonth = month - 1;
        let prevYear = year;
        if (prevMonth < 1) {
            prevMonth = 12;
            prevYear = year - 1;
        }

        const matchFilter = {
            academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
            $or: [
                { month, year },
                { month: prevMonth, year: prevYear }
            ]
        };
        if (classId) {
            matchFilter.class = new mongoose.Types.ObjectId(classId);
        }

        const studentAverages = await StudentRating.aggregate([
            { $match: matchFilter },
            {
                $group: {
                    _id: { student: '$student', month: '$month', year: '$year' },
                    avgScore: { $avg: '$averageScore' },
                    class: { $first: '$class' }
                }
            },
            {
                $group: {
                    _id: '$_id.student',
                    months: {
                        $push: {
                            month: '$_id.month',
                            year: '$_id.year',
                            avgScore: '$avgScore'
                        }
                    },
                    class: { $first: '$class' }
                }
            },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'studentInfo'
                }
            },
            { $unwind: '$studentInfo' },
            {
                $lookup: {
                    from: 'classes',
                    localField: 'class',
                    foreignField: '_id',
                    as: 'classInfo'
                }
            },
            { $unwind: { path: '$classInfo', preserveNullAndEmptyArrays: true } }
        ]);

        const improving = [];
        const declining = [];
        const stable = [];

        studentAverages.forEach(s => {
            const current = s.months.find(m => m.month === month && m.year === year);
            const previous = s.months.find(m => m.month === prevMonth && m.year === prevYear);

            if (!current || !previous) return; // Need both months for comparison

            const change = parseFloat((current.avgScore - previous.avgScore).toFixed(2));
            const entry = {
                student: {
                    _id: s.studentInfo._id,
                    name: s.studentInfo.name,
                    gender: s.studentInfo.gender,
                    regNo: s.studentInfo.regNo
                },
                class: s.classInfo ? {
                    _id: s.classInfo._id,
                    label: s.classInfo.label,
                    section: s.classInfo.section,
                    branch: s.classInfo.branch
                } : null,
                currentAvg: parseFloat(current.avgScore.toFixed(2)),
                previousAvg: parseFloat(previous.avgScore.toFixed(2)),
                change
            };

            if (change > 0.25) improving.push(entry);
            else if (change < -0.25) declining.push(entry);
            else stable.push(entry);
        });

        // Sort by magnitude of change
        improving.sort((a, b) => b.change - a.change);
        declining.sort((a, b) => a.change - b.change);

        res.json({
            success: true,
            month,
            year,
            previousMonth: prevMonth,
            previousYear: prevYear,
            improving,
            declining,
            stable: stable.length,
            summary: {
                totalCompared: improving.length + declining.length + stable.length,
                improvingCount: improving.length,
                decliningCount: declining.length,
                stableCount: stable.length
            }
        });
    } catch (err) {
        console.error('Error fetching rating movers:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ──────────────────────────────────────────────
//  SUBMISSION TRACKER ENDPOINTS (Phase 4)
// ──────────────────────────────────────────────

// @route   GET /api/student-ratings/tracker
// @desc    Get school-wide submission tracker — teacher-wise and class-wise status
// @access  Private (Admin)
router.get('/tracker', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        // Get all subjects for the academic year with their teachers and classes
        const allSubjects = await Subject.find({ academicYear: req.academicYearContext })
            .populate('class', 'value label section branch')
            .populate('teachers', 'name designation')
            .lean();

        // Filter out subjects with missing class
        const validSubjects = allSubjects.filter(s => s.class);

        // Get student counts per class
        const classIds = [...new Set(validSubjects.map(s => s.class._id.toString()))];
        const studentCounts = await User.aggregate([
            {
                $match: {
                    role: 'student',
                    currentClass: { $in: classIds.map(id => new mongoose.Types.ObjectId(id)) },
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
                    isActive: true
                }
            },
            {
                $group: { _id: '$currentClass', count: { $sum: 1 } }
            }
        ]);
        const studentCountMap = {};
        studentCounts.forEach(sc => { studentCountMap[sc._id.toString()] = sc.count; });

        // Get rating counts per subject per teacher
        const ratingCounts = await StudentRating.aggregate([
            {
                $match: {
                    month,
                    year,
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                }
            },
            {
                $group: {
                    _id: { subject: '$subject', teacher: '$teacher' },
                    count: { $sum: 1 }
                }
            }
        ]);
        const ratingCountMap = {};
        ratingCounts.forEach(rc => {
            const key = `${rc._id.subject.toString()}_${rc._id.teacher.toString()}`;
            ratingCountMap[key] = rc.count;
        });

        // Build teacher-wise view
        const teacherMap = {};
        validSubjects.forEach(subject => {
            const totalStudents = studentCountMap[subject.class._id.toString()] || 0;

            (subject.teachers || []).forEach(teacher => {
                if (!teacher) return;
                const teacherId = teacher._id.toString();
                const ratingKey = `${subject._id.toString()}_${teacherId}`;
                const ratedCount = ratingCountMap[ratingKey] || 0;
                const isCompleted = totalStudents > 0 && ratedCount >= totalStudents;

                if (!teacherMap[teacherId]) {
                    teacherMap[teacherId] = {
                        teacher: { _id: teacher._id, name: teacher.name, designation: teacher.designation },
                        total: 0,
                        completed: 0,
                        pending: 0,
                        subjects: []
                    };
                }

                teacherMap[teacherId].total += 1;
                if (isCompleted) {
                    teacherMap[teacherId].completed += 1;
                } else {
                    teacherMap[teacherId].pending += 1;
                }

                teacherMap[teacherId].subjects.push({
                    subject: { _id: subject._id, name: subject.name },
                    class: subject.class,
                    totalStudents,
                    ratedCount,
                    status: isCompleted ? 'submitted' : 'pending'
                });
            });
        });

        const teachers = Object.values(teacherMap).sort((a, b) => {
            // Pending first, then alphabetically
            if (a.pending !== b.pending) return b.pending - a.pending;
            return a.teacher.name.localeCompare(b.teacher.name);
        });

        const totalSubjectEntries = teachers.reduce((s, t) => s + t.total, 0);
        const totalCompleted = teachers.reduce((s, t) => s + t.completed, 0);

        res.json({
            success: true,
            type: 'ratings',
            month,
            year,
            overall: {
                total: totalSubjectEntries,
                completed: totalCompleted,
                pending: totalSubjectEntries - totalCompleted,
                percentage: totalSubjectEntries > 0
                    ? Math.round((totalCompleted / totalSubjectEntries) * 100)
                    : 0
            },
            teachers
        });
    } catch (err) {
        console.error('Error fetching rating tracker:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/student-ratings/tracker/my-status
// @desc    Get teacher's own submission status for the tracker
// @access  Private (Teacher)
router.get('/tracker/my-status', [auth, yearContext], async (req, res) => {
    try {
        const userId = req.user.userId;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        // Reuse the my-subjects logic
        let subjects = await Subject.find({
            teachers: userId,
            academicYear: req.academicYearContext
        })
            .populate('class', 'value label section branch')
            .sort({ name: 1 });

        subjects = subjects.filter(s => s.class);

        const subjectIds = subjects.map(s => s._id);

        // Get existing rating counts
        const ratingCounts = await StudentRating.aggregate([
            {
                $match: {
                    teacher: new mongoose.Types.ObjectId(userId),
                    subject: { $in: subjectIds },
                    month,
                    year,
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                }
            },
            {
                $group: { _id: '$subject', count: { $sum: 1 } }
            }
        ]);

        const ratingCountMap = {};
        ratingCounts.forEach(rc => { ratingCountMap[rc._id.toString()] = rc.count; });

        // Get student counts
        const classIds = [...new Set(subjects.map(s => s.class._id.toString()))];
        const studentCounts = await User.aggregate([
            {
                $match: {
                    role: 'student',
                    currentClass: { $in: classIds.map(id => new mongoose.Types.ObjectId(id)) },
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
                    isActive: true
                }
            },
            {
                $group: { _id: '$currentClass', count: { $sum: 1 } }
            }
        ]);
        const studentCountMap = {};
        studentCounts.forEach(sc => { studentCountMap[sc._id.toString()] = sc.count; });

        let completed = 0;
        const subjectStatuses = subjects.map(subject => {
            const totalStudents = studentCountMap[subject.class._id.toString()] || 0;
            const ratedCount = ratingCountMap[subject._id.toString()] || 0;
            const isCompleted = totalStudents > 0 && ratedCount >= totalStudents;
            if (isCompleted) completed += 1;

            return {
                subject: { _id: subject._id, name: subject.name },
                class: subject.class,
                totalStudents,
                ratedCount,
                status: isCompleted ? 'submitted' : 'pending'
            };
        });

        res.json({
            success: true,
            month,
            year,
            total: subjectStatuses.length,
            completed,
            pending: subjectStatuses.length - completed,
            percentage: subjectStatuses.length > 0
                ? Math.round((completed / subjectStatuses.length) * 100)
                : 0,
            subjects: subjectStatuses
        });
    } catch (err) {
        console.error('Error fetching teacher rating status:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;
