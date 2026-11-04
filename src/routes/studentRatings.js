const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { validationResult } = require('express-validator');
const { authenticateToken: auth, requireAdmin, checkRole } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');
const StudentRating = require('../models/StudentRating');
const Subject = require('../models/Subject');
const User = require('../models/User');
const {
    bulkRatingValidation,
    adminBulkDeleteValidation,
    adminShiftMonthValidation,
    singleStudentRatingDeleteValidation
} = require('../validations/studentRating');
const { getISTMonthYear, getPreviousMonthYear } = require('../utils/dateUtils');
const { logAudit } = require('../utils/auditLogger');
const { cacheGet, cacheSet, cacheInvalidatePattern } = require('../config/redis');

// In-memory cache for high-frequency dashboard reads
const dashboardCache = new Map();
const DASHBOARD_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes in-memory
const DASHBOARD_REDIS_TTL_SEC = 180; // 3 minutes in Redis

const invalidateRatingCaches = async () => {
    dashboardCache.clear();
    try {
        await cacheInvalidatePattern('student-ratings:*');
        await cacheInvalidatePattern('ratings:*');
    } catch (_) {}
};

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];

const hasObjectIdMatch = (ids = [], userId) => ids.some((id) => id && id.toString() === userId);

/**
 * Validates cross-role access to individual student ratings to prevent information leaks.
 * - Admin/Super Admin: allowed.
 * - Teacher/Staff/Support Staff: allowed read-only access for school-wide holistic student evaluation.
 * - Student: allowed only for their own userId.
 */
const canAccessStudentRatings = async (callerUser, targetStudentId, _academicYearContext) => {
    if (!callerUser) return false;
    const role = callerUser.role;
    if (role === 'admin' || role === 'super admin') {
        return true;
    }
    if (role === 'teacher' || role === 'staff' || role === 'support_staff') {
        return true;
    }
    if (role === 'student') {
        return callerUser.userId === targetStudentId.toString();
    }
    return false;
};

// ──────────────────────────────────────────────
//  TEACHER ENDPOINTS
// ──────────────────────────────────────────────

// @route   GET /api/student-ratings/my-subjects
// @desc    Get teacher's subjects with rating submission status for a given month
// @access  Private (Teacher/Admin)
router.get('/my-subjects', [auth, yearContext, checkRole(['teacher', 'staff', 'support_staff', 'admin', 'super admin'])], async (req, res) => {
    try {
        const userId = req.user.userId;
        const istNow = getISTMonthYear();
        const month = parseInt(req.query.month) || istNow.month;
        const year = parseInt(req.query.year) || istNow.year;
        const isPastMonth = year < istNow.year || (year === istNow.year && month < istNow.month);

        // Get all subjects this teacher teaches in the current academic year that are enabled for ratings
        let subjects = await Subject.find({
            teachers: userId,
            academicYear: req.academicYearContext,
            ratingEnabled: { $ne: false } // Exclude subjects that admin disabled ratings for
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
                isPastMonth,
                subjects: [],
                summary: { total: 0, completed: 0, pending: 0, missed: 0 }
            });
        }

        // Check which subjects already have ratings submitted for this month (by this teacher OR assigned co-teacher)
        const subjectIds = subjects.map(s => s._id);
        const existingRatings = await StudentRating.aggregate([
            {
                $match: {
                    subject: { $in: subjectIds },
                    month,
                    year,
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                }
            },
            {
                $group: {
                    _id: '$subject',
                    count: { $sum: 1 },
                    teachers: { $addToSet: '$teacher' }
                }
            }
        ]);

        const ratingCountMap = {};
        existingRatings.forEach(r => {
            ratingCountMap[r._id.toString()] = {
                count: r.count,
                submittedBy: r.teachers
            };
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

        // Build response (filter out empty classes with 0 students and 0 ratings)
        const subjectsWithStatus = subjects
            .filter(subject => {
                const totalStudents = studentCountMap[subject.class._id.toString()] || 0;
                const rData = ratingCountMap[subject._id.toString()] || { count: 0, submittedBy: [] };
                return totalStudents > 0 || rData.count > 0;
            })
            .map(subject => {
                const classId = subject.class._id.toString();
                const totalStudents = studentCountMap[classId] || 0;
                const rData = ratingCountMap[subject._id.toString()] || { count: 0, submittedBy: [] };
                const ratedCount = rData.count;
                const isCompleted = totalStudents > 0 && ratedCount >= totalStudents;
                const status = isCompleted ? 'submitted' : (isPastMonth ? 'missed' : 'pending');

                return {
                    _id: subject._id,
                    name: subject.name,
                    class: subject.class,
                    totalStudents,
                    ratedCount,
                    status
                };
            });

        const completed = subjectsWithStatus.filter(s => s.status === 'submitted').length;
        const missed = subjectsWithStatus.filter(s => s.status === 'missed').length;
        const pending = subjectsWithStatus.filter(s => s.status === 'pending').length;

        res.json({
            success: true,
            month,
            year,
            isPastMonth,
            subjects: subjectsWithStatus,
            summary: {
                total: subjectsWithStatus.length,
                completed,
                pending,
                missed
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
        const defaultMY = getISTMonthYear();
        const month = parseInt(req.query.month) || defaultMY.month;
        const year = parseInt(req.query.year) || defaultMY.year;
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

        if (subject.ratingEnabled === false && !isAdmin) {
            return res.status(400).json({
                success: false,
                message: `Ratings are disabled for subject "${subject.name}" by the administrator.`
            });
        }

        // Get all students in this class
        const students = await User.find({
            currentClass: subject.class._id,
            role: 'student',
            academicYear: req.academicYearContext,
            isActive: true
        })
            .select('name phone gender regNo profilePhoto')
            .sort({ name: 1 })
            .lean();

        // Get existing ratings for these students
        const existingRatings = await StudentRating.find({
            subject: subjectId,
            month,
            year,
            academicYear: req.academicYearContext
        })
            .populate('teacher', 'name email designation')
            .populate('lastModifiedBy', 'name email designation')
            .select('student classEngagement homeworkClasswork behaviourSocial englishComm averageScore isExempt exemptionReason remarks submittedAt updatedAt teacher lastModifiedBy')
            .lean();

        let lastSubmissionInfo = null;
        if (existingRatings.length > 0) {
            const first = existingRatings[0];
            const author = first.lastModifiedBy || first.teacher;
            lastSubmissionInfo = {
                teacherName: author?.name || 'A teacher',
                teacherId: author?._id,
                submittedAt: first.updatedAt || first.submittedAt
            };
        }

        const ratingMap = {};
        existingRatings.forEach(r => {
            ratingMap[r.student.toString()] = {
                classEngagement: r.classEngagement,
                homeworkClasswork: r.homeworkClasswork,
                behaviourSocial: r.behaviourSocial,
                englishComm: r.englishComm,
                averageScore: r.averageScore,
                isExempt: Boolean(r.isExempt),
                exemptionReason: r.exemptionReason || '',
                remarks: r.remarks || ''
            };
        });

        // Merge students with their ratings (if any)
        const studentsWithRatings = students.map(student => ({
            _id: student._id,
            name: student.name,
            gender: student.gender,
            regNo: student.regNo,
            profilePhoto: student.profilePhoto,
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
            lastSubmissionInfo,
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

        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (_) {}
        }
        const { subjectId, month, year, ratings } = body || {};
        const userId = req.user.userId;
        const userRole = req.user.role;

        // Prevent ratings for future months
        const istNow = getISTMonthYear();
        if (year > istNow.year || (year === istNow.year && month > istNow.month)) {
            return res.status(400).json({
                success: false,
                message: 'Cannot submit ratings for future months.'
            });
        }

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

        if (subject.ratingEnabled === false && !isAdmin) {
            return res.status(400).json({
                success: false,
                message: `Ratings are disabled for subject "${subject.name}" by the administrator.`
            });
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
            const isExempt = Boolean(r.isExempt);
            const avg = isExempt ? null : parseFloat(
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
                            subjectName: subject.name,
                            teacher: new mongoose.Types.ObjectId(userId),
                            lastModifiedBy: new mongoose.Types.ObjectId(userId),
                            isExempt,
                            exemptionReason: r.exemptionReason || '',
                            classEngagement: isExempt ? null : r.classEngagement,
                            homeworkClasswork: isExempt ? null : r.homeworkClasswork,
                            behaviourSocial: isExempt ? null : r.behaviourSocial,
                            englishComm: isExempt ? null : r.englishComm,
                            averageScore: avg,
                            remarks: r.remarks || '',
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

        invalidateRatingCaches().catch(() => {});

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
        const defaultMY = getPreviousMonthYear();
        const month = parseInt(req.query.month) || defaultMY.month;
        const year = parseInt(req.query.year) || defaultMY.year;

        const ratings = await StudentRating.find({
            class: classId,
            month,
            year,
            academicYear: req.academicYearContext
        })
            .populate('student', 'name gender regNo profilePhoto')
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
            if (!r.student || !r.student._id) return;
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
                averageScore: r.averageScore,
                isExempt: Boolean(r.isExempt),
                exemptionReason: r.exemptionReason || '',
                remarks: r.remarks || ''
            });
            if (!r.isExempt && r.averageScore != null && !isNaN(r.averageScore)) {
                studentMap[sid].totalAvg += r.averageScore;
                studentMap[sid].count += 1;
            }
        });

        const students = Object.values(studentMap).map(s => {
            const overallAverage = s.count > 0 ? parseFloat((s.totalAvg / s.count).toFixed(2)) : 0;
            return {
                student: s.student,
                overallAverage,
                subjectCount: s.subjects.length,
                ratedCount: s.count,
                subjects: s.subjects
            };
        });

        // Sort by overall average descending
        students.sort((a, b) => b.overallAverage - a.overallAverage);

        // Class-level averages (only from students with valid rated scores)
        const ratedStudents = students.filter(s => s.overallAverage > 0);
        const classAverage = ratedStudents.length > 0
            ? parseFloat((ratedStudents.reduce((a, b) => a + b.overallAverage, 0) / ratedStudents.length).toFixed(2))
            : null;

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

// ──────────────────────────────────────────────
//  STUDENT SELF-SERVICE ENDPOINTS
// ──────────────────────────────────────────────

// @route   GET /api/student-ratings/my-ratings
// @desc    Get logged-in student's ratings, monthly average, criteria breakdown, trend and subject breakdown
// @access  Private (Student)
router.get('/my-ratings', [auth, yearContext, checkRole(['student'])], async (req, res) => {
    try {
        const studentId = req.user.userId;
        const defaultMY = getPreviousMonthYear();
        const month = parseInt(req.query.month) || defaultMY.month;
        const year = parseInt(req.query.year) || defaultMY.year;

        // 1. Fetch student info to know their current class
        const student = await User.findById(studentId).select('name gender regNo currentClass').lean();
        if (!student) {
            return res.status(404).json({ success: false, message: 'Student not found' });
        }

        // 2. Fetch all subjects for student's class to know ratable subjects
        const classSubjects = await Subject.find({
            class: student.currentClass,
            academicYear: req.academicYearContext
        }).select('name ratingEnabled teachers').lean();

        // 3. Fetch ratings for this student in the selected month/year
        const ratings = await StudentRating.find({
            student: studentId,
            month,
            year,
            academicYear: req.academicYearContext
        })
            .populate('subject', 'name ratingEnabled')
            .lean();

        // Filter ratings for scoring: non-exempt with an averageScore and active subject
        const scorableRatings = ratings.filter(r => !r.isExempt && r.averageScore != null && r.subject && r.subject.ratingEnabled !== false);

        // 4. Compute overall and criteria averages
        let avgEngagement = 0, avgHomework = 0, avgBehaviour = 0, avgEnglish = 0, overallAverage = null;
        if (scorableRatings.length > 0) {
            avgEngagement = parseFloat((scorableRatings.reduce((s, r) => s + (r.classEngagement || 0), 0) / scorableRatings.length).toFixed(2));
            avgHomework = parseFloat((scorableRatings.reduce((s, r) => s + (r.homeworkClasswork || 0), 0) / scorableRatings.length).toFixed(2));
            avgBehaviour = parseFloat((scorableRatings.reduce((s, r) => s + (r.behaviourSocial || 0), 0) / scorableRatings.length).toFixed(2));
            avgEnglish = parseFloat((scorableRatings.reduce((s, r) => s + (r.englishComm || 0), 0) / scorableRatings.length).toFixed(2));
            overallAverage = parseFloat((scorableRatings.reduce((s, r) => s + r.averageScore, 0) / scorableRatings.length).toFixed(2));
        }

        // 5. Subject breakdown list (including current ratable subjects + any historically rated subjects)
        const ratingMap = {};
        ratings.forEach(r => {
            if (r.subject?._id) {
                ratingMap[r.subject._id.toString()] = r;
            }
        });

        const allSubjectMap = new Map();
        classSubjects.filter(s => s.ratingEnabled !== false).forEach(sub => {
            allSubjectMap.set(sub._id.toString(), {
                subjectId: sub._id,
                subjectName: sub.name,
                ratingEnabled: sub.ratingEnabled
            });
        });

        ratings.forEach(r => {
            if (r.subject) {
                const sid = r.subject._id.toString();
                if (!allSubjectMap.has(sid)) {
                    allSubjectMap.set(sid, {
                        subjectId: r.subject._id,
                        subjectName: r.subjectName || r.subject.name,
                        ratingEnabled: r.subject.ratingEnabled
                    });
                }
            }
        });

        const subjectBreakdown = Array.from(allSubjectMap.values()).map(sub => {
            const r = ratingMap[sub.subjectId.toString()];
            return {
                subjectId: sub.subjectId,
                subjectName: sub.subjectName,
                isRated: !!r,
                isExempt: Boolean(r?.isExempt),
                exemptionReason: r?.exemptionReason || '',
                remarks: r?.remarks || '',
                averageScore: r ? r.averageScore : null,
                classEngagement: r ? r.classEngagement : null,
                homeworkClasswork: r ? r.homeworkClasswork : null,
                behaviourSocial: r ? r.behaviourSocial : null,
                englishComm: r ? r.englishComm : null
            };
        });

        // 6. Anonymous class benchmark for selected month (if student has class)
        let classBenchmark = null;
        if (student.currentClass) {
            const classRatingAgg = await StudentRating.aggregate([
                {
                    $match: {
                        class: student.currentClass,
                        month,
                        year,
                        academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
                        isExempt: { $ne: true },
                        averageScore: { $ne: null }
                    }
                },
                {
                    $group: {
                        _id: null,
                        classAvg: { $avg: '$averageScore' },
                        totalRatings: { $sum: 1 }
                    }
                }
            ]);
            if (classRatingAgg.length > 0 && classRatingAgg[0].classAvg != null) {
                classBenchmark = parseFloat(classRatingAgg[0].classAvg.toFixed(2));
            }
        }

        // 7. Student trend (all months in academic year)
        const allStudentRatings = await StudentRating.find({
            student: studentId,
            academicYear: req.academicYearContext
        })
            .populate('subject', 'name ratingEnabled')
            .sort({ year: 1, month: 1 })
            .lean();

        const currentMY = getISTMonthYear();
        const MONTH_NAMES = [
            'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'
        ];

        const trendMonthMap = {};
        allStudentRatings
            .filter(r => !r.isExempt && r.averageScore != null && r.subject && r.subject.ratingEnabled !== false)
            .forEach(r => {
                const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
                if (!trendMonthMap[key]) {
                    trendMonthMap[key] = {
                        month: r.month,
                        year: r.year,
                        scores: []
                    };
                }
                trendMonthMap[key].scores.push(r.averageScore);
            });

        const trend = Object.values(trendMonthMap).map(m => ({
            month: m.month,
            year: m.year,
            averageScore: parseFloat((m.scores.reduce((a, b) => a + b, 0) / m.scores.length).toFixed(2)),
            ratedSubjectCount: m.scores.length,
            isCurrentMonth: (m.month === currentMY.month && m.year === currentMY.year)
        })).sort((a, b) => `${a.year}-${String(a.month).padStart(2, '0')}`.localeCompare(`${b.year}-${String(b.month).padStart(2, '0')}`));

        // 8. Cumulative Academic Year Metrics for this student
        const validYearRatings = allStudentRatings.filter(
            r => !r.isExempt && r.averageScore != null && r.subject && r.subject.ratingEnabled !== false
        );
        const cumulativeCount = validYearRatings.length;
        let yearAverage = null;
        let cumEngagement = 0, cumHomework = 0, cumBehaviour = 0, cumEnglish = 0;

        if (cumulativeCount > 0) {
            yearAverage = parseFloat(
                (validYearRatings.reduce((s, r) => s + r.averageScore, 0) / cumulativeCount).toFixed(2)
            );
            cumEngagement = parseFloat(
                (validYearRatings.reduce((s, r) => s + (r.classEngagement || 0), 0) / cumulativeCount).toFixed(2)
            );
            cumHomework = parseFloat(
                (validYearRatings.reduce((s, r) => s + (r.homeworkClasswork || 0), 0) / cumulativeCount).toFixed(2)
            );
            cumBehaviour = parseFloat(
                (validYearRatings.reduce((s, r) => s + (r.behaviourSocial || 0), 0) / cumulativeCount).toFixed(2)
            );
            cumEnglish = parseFloat(
                (validYearRatings.reduce((s, r) => s + (r.englishComm || 0), 0) / cumulativeCount).toFixed(2)
            );
        }

        const cumulativeEvaluation = StudentRating.getPerformanceEvaluation(yearAverage);
        const cumulativeDataPoints = {
            classEngagement: cumEngagement,
            homeworkClasswork: cumHomework,
            behaviourSocial: cumBehaviour,
            englishComm: cumEnglish
        };

        // 9. Class Cumulative Benchmark & Peer Comparison
        let classCumulativeBenchmark = null;
        let classComparison = null;
        if (student.currentClass) {
            const classRatingAgg = await StudentRating.aggregate([
                {
                    $match: {
                        class: student.currentClass,
                        academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
                        isExempt: { $ne: true },
                        averageScore: { $ne: null }
                    }
                },
                {
                    $group: {
                        _id: '$student',
                        studentAvg: { $avg: '$averageScore' }
                    }
                },
                { $sort: { studentAvg: -1 } }
            ]);

            if (classRatingAgg.length > 0) {
                const classSum = classRatingAgg.reduce((s, c) => s + c.studentAvg, 0);
                classCumulativeBenchmark = parseFloat((classSum / classRatingAgg.length).toFixed(2));
                const studentIdx = classRatingAgg.findIndex(c => c._id.toString() === studentId.toString());
                const studentRank = studentIdx !== -1 ? studentIdx + 1 : null;
                const diff = yearAverage != null
                    ? parseFloat((yearAverage - classCumulativeBenchmark).toFixed(2))
                    : null;

                let standingLabel = 'On Par with Class';
                if (studentRank === 1) standingLabel = 'Top Performer';
                else if (diff != null && diff >= 0.4) standingLabel = 'Well Above Class Avg';
                else if (diff != null && diff > 0.0) standingLabel = 'Above Class Average';
                else if (diff != null && diff === 0.0) standingLabel = 'On Par with Class';
                else if (diff != null) standingLabel = 'Below Class Average';

                classComparison = {
                    classCumulativeAverage: classCumulativeBenchmark,
                    difference: diff,
                    rank: studentRank,
                    totalStudents: classRatingAgg.length,
                    standingLabel
                };
            }
        }

        // 10. Current Calendar Month Live Summary & Provisional Rating
        const currentMonthRatings = allStudentRatings.filter(
            r => r.month === currentMY.month && r.year === currentMY.year && !r.isExempt && r.averageScore != null && r.subject && r.subject.ratingEnabled !== false
        );
        const curRatedCount = currentMonthRatings.length;
        const ratableSubjectsList = classSubjects.filter(s => s.ratingEnabled !== false);
        const ratableSubjectCount = ratableSubjectsList.length;

        let curStatus = 'not_started';
        if (ratableSubjectCount > 0 && curRatedCount >= ratableSubjectCount) {
            curStatus = 'completed';
        } else if (curRatedCount > 0) {
            curStatus = 'in_progress';
        }

        let provisionalAvg = null;
        if (curRatedCount > 0) {
            provisionalAvg = parseFloat(
                (currentMonthRatings.reduce((s, r) => s + r.averageScore, 0) / curRatedCount).toFixed(2)
            );
        }
        const curEval = StudentRating.getPerformanceEvaluation(provisionalAvg);

        const currentMonthSummary = {
            month: currentMY.month,
            year: currentMY.year,
            monthName: MONTH_NAMES[currentMY.month - 1],
            status: curStatus,
            ratedCount: curRatedCount,
            totalSubjects: ratableSubjectCount,
            provisionalAverage: provisionalAvg,
            label: curEval.label,
            variant: curEval.variant,
            isCurrentMonth: (month === currentMY.month && year === currentMY.year)
        };

        // 11. Cumulative Subject Performance & Qualitative Remarks Feed (for Tab 3)
        const subjectRatingsMap = new Map();
        // Initialize with all class ratable subjects
        ratableSubjectsList.forEach(sub => {
            subjectRatingsMap.set(sub._id.toString(), {
                subjectId: sub._id,
                subjectName: sub.name,
                ratingEnabled: sub.ratingEnabled,
                ratings: []
            });
        });

        const teacherRemarksFeed = [];
        allStudentRatings.forEach(r => {
            if (r.subject) {
                const sid = r.subject._id.toString();
                if (!subjectRatingsMap.has(sid)) {
                    subjectRatingsMap.set(sid, {
                        subjectId: r.subject._id,
                        subjectName: r.subjectName || r.subject.name,
                        ratingEnabled: r.subject.ratingEnabled,
                        ratings: []
                    });
                }
                const entry = subjectRatingsMap.get(sid);
                entry.ratings.push(r);

                // Collect remarks for feed
                if (r.remarks && r.remarks.trim()) {
                    teacherRemarksFeed.push({
                        id: r._id,
                        subjectId: r.subject._id,
                        subjectName: r.subjectName || r.subject.name,
                        month: r.month,
                        year: r.year,
                        monthName: MONTH_NAMES[r.month - 1] || `Month ${r.month}`,
                        remarks: r.remarks.trim(),
                        averageScore: r.averageScore,
                        isExempt: Boolean(r.isExempt),
                        submittedAt: r.submittedAt || r.updatedAt
                    });
                }
            }
        });

        // Sort remarks chronologically descending (newest first)
        teacherRemarksFeed.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

        const cumulativeSubjects = Array.from(subjectRatingsMap.values()).map(sub => {
            const validSubRatings = sub.ratings.filter(
                r => !r.isExempt && r.averageScore != null
            );
            const count = validSubRatings.length;
            const subAvg = count > 0
                ? parseFloat((validSubRatings.reduce((s, r) => s + r.averageScore, 0) / count).toFixed(2))
                : null;
            const subEval = StudentRating.getPerformanceEvaluation(subAvg);

            return {
                subjectId: sub.subjectId,
                subjectName: sub.subjectName,
                ratingEnabled: sub.ratingEnabled,
                evaluatedMonthsCount: count,
                cumulativeAverage: subAvg,
                evaluation: subEval,
                criteriaAverages: {
                    classEngagement: count > 0 ? parseFloat((validSubRatings.reduce((s, r) => s + (r.classEngagement || 0), 0) / count).toFixed(2)) : null,
                    homeworkClasswork: count > 0 ? parseFloat((validSubRatings.reduce((s, r) => s + (r.homeworkClasswork || 0), 0) / count).toFixed(2)) : null,
                    behaviourSocial: count > 0 ? parseFloat((validSubRatings.reduce((s, r) => s + (r.behaviourSocial || 0), 0) / count).toFixed(2)) : null,
                    englishComm: count > 0 ? parseFloat((validSubRatings.reduce((s, r) => s + (r.englishComm || 0), 0) / count).toFixed(2)) : null,
                },
                remarksCount: sub.ratings.filter(r => r.remarks && r.remarks.trim()).length
            };
        });

        const isCurrentMonth = (month === currentMY.month && year === currentMY.year);
        const monthStatus = isCurrentMonth
            ? curStatus
            : (scorableRatings.length >= ratableSubjectCount ? 'completed' : 'finalized');

        const evaluation = StudentRating.getPerformanceEvaluation(overallAverage);

        res.json({
            success: true,
            student: {
                _id: student._id,
                name: student.name,
                regNo: student.regNo,
                gender: student.gender
            },
            // Selected Month details (for Tab 2: Month-by-Month)
            month,
            year,
            monthName: MONTH_NAMES[month - 1] || `Month ${month}`,
            isCurrentMonth,
            monthStatus,
            overallAverage,
            evaluation,
            dataPointAverages: {
                classEngagement: avgEngagement,
                homeworkClasswork: avgHomework,
                behaviourSocial: avgBehaviour,
                englishComm: avgEnglish
            },
            subjects: subjectBreakdown,
            classBenchmark,

            // Cumulative Academic Year Metrics (for Tab 1 & Dashboard)
            yearAverage, // Backward compatibility
            cumulativeAverage: yearAverage,
            cumulativeCount,
            cumulativeEvaluation,
            cumulativeDataPoints,
            classCumulativeBenchmark,
            classComparison,

            // Current Month Real-Time Status
            currentMonth: currentMonthSummary,

            // Cumulative Subject Performance & Qualitative Remarks (for Tab 3)
            cumulativeSubjects,
            teacherRemarksFeed,

            trend,
            dataPoints: StudentRating.DATA_POINTS,
            ratingLabels: StudentRating.RATING_LABELS
        });
    } catch (err) {
        console.error('Error fetching student my-ratings:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ──────────────────────────────────────────────
//  ADMIN SUBJECT RATING CONFIGURATION ENDPOINTS
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
//  ADMIN SUBJECT RATING CONFIGURATION ENDPOINTS (SCHOOL-WIDE SUBJECT-WISE)
// ──────────────────────────────────────────────

// @route   GET /api/student-ratings/admin/subjects-config
// @desc    Get all distinct subjects school-wide with ratingEnabled status, classes, and teachers
// @access  Private (Admin)
router.get('/admin/subjects-config', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        const subjects = await Subject.find({ academicYear: req.academicYearContext })
            .populate('class', 'value label name section branch')
            .populate('teachers', 'name email profilePhoto designation')
            .sort({ name: 1 })
            .lean();

        // Group school-wide by normalized subject name
        const subjectMap = {};
        const classMap = {};

        subjects.forEach(sub => {
            const rawName = (sub.name || '').trim();
            if (!rawName) return;
            const key = rawName.toLowerCase();

            if (!subjectMap[key]) {
                subjectMap[key] = {
                    name: rawName,
                    ratingEnabled: sub.ratingEnabled !== false,
                    totalClasses: 0,
                    classes: [],
                    teachers: [],
                    subjectIds: []
                };
            }

            subjectMap[key].subjectIds.push(sub._id);

            // If any instance in this academic year has rating disabled, reflect as disabled
            if (sub.ratingEnabled === false) {
                subjectMap[key].ratingEnabled = false;
            }

            if (sub.class) {
                subjectMap[key].totalClasses += 1;
                const cName = sub.class.name || sub.class.label || sub.class.value || 'Class';
                const cSection = sub.class.section ? ` - ${sub.class.section}` : '';
                const cLabel = `${cName}${cSection}`;
                subjectMap[key].classes.push({
                    _id: sub.class._id,
                    name: sub.class.name,
                    label: cLabel,
                    value: sub.class.value,
                    section: sub.class.section,
                    branch: sub.class.branch
                });

                // Also maintain legacy classMap for backward compatibility
                const cid = sub.class._id.toString();
                if (!classMap[cid]) {
                    classMap[cid] = {
                        class: sub.class,
                        totalSubjects: 0,
                        ratableSubjects: 0,
                        subjects: []
                    };
                }
                classMap[cid].totalSubjects += 1;
                if (sub.ratingEnabled !== false) classMap[cid].ratableSubjects += 1;
                classMap[cid].subjects.push({
                    _id: sub._id,
                    name: sub.name,
                    ratingEnabled: sub.ratingEnabled !== false,
                    teachers: sub.teachers || []
                });
            }

            if (Array.isArray(sub.teachers)) {
                sub.teachers.forEach(t => {
                    if (t && t._id) {
                        const tId = t._id.toString();
                        if (!subjectMap[key].teachers.some(existing => existing._id?.toString() === tId)) {
                            subjectMap[key].teachers.push({
                                _id: t._id,
                                name: t.name,
                                email: t.email,
                                profilePhoto: t.profilePhoto,
                                designation: t.designation || 'Teacher'
                            });
                        }
                    }
                });
            }
        });

        const subjectList = Object.values(subjectMap).sort((a, b) => a.name.localeCompare(b.name));
        const totalSubjects = subjectList.length;
        const enabledCount = subjectList.filter(s => s.ratingEnabled !== false).length;
        const disabledCount = totalSubjects - enabledCount;

        res.json({
            success: true,
            subjects: subjectList,
            totalSubjects,
            enabledCount,
            disabledCount,
            classes: Object.values(classMap) // preserved for any legacy consumers
        });
    } catch (err) {
        console.error('Error fetching subjects config:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   PATCH/POST/PUT /api/student-ratings/admin/toggle-subject
// @desc    Toggle ratingEnabled for a subject across ALL classes school-wide
// @access  Private (Admin)
const toggleSubjectHandler = async (req, res) => {
    try {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (_) {}
        }
        const { subjectName, ratingEnabled } = body || {};
        if (!subjectName || typeof subjectName !== 'string') {
            return res.status(400).json({ success: false, message: 'subjectName string is required' });
        }

        const trimmedName = subjectName.trim();
        const isEnabled = ratingEnabled !== undefined ? Boolean(ratingEnabled) : true;
        const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const updateResult = await Subject.updateMany(
            {
                name: { $regex: new RegExp(`^${escaped}$`, 'i') },
                academicYear: req.academicYearContext
            },
            { $set: { ratingEnabled: isEnabled } }
        );

        res.json({
            success: true,
            message: `Student ratings ${isEnabled ? 'enabled' : 'disabled'} for "${trimmedName}" across all ${updateResult.modifiedCount} class(es)`,
            subjectName: trimmedName,
            ratingEnabled: isEnabled,
            modifiedCount: updateResult.modifiedCount
        });
    } catch (err) {
        console.error('Error toggling subject rating school-wide:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

router.route('/admin/toggle-subject')
    .patch(auth, yearContext, requireAdmin, toggleSubjectHandler)
    .post(auth, yearContext, requireAdmin, toggleSubjectHandler)
    .put(auth, yearContext, requireAdmin, toggleSubjectHandler);

// @route   PATCH/POST/PUT /api/student-ratings/admin/subject/:subjectId/toggle-rating
// @desc    Toggle ratingEnabled for a subject — updates ALL classes with that subject name
// @access  Private (Admin)
const toggleRatingBySubjectIdHandler = async (req, res) => {
    try {
        const { subjectId } = req.params;
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (_) {}
        }
        const { ratingEnabled } = body || {};

        const subject = await Subject.findById(subjectId);
        if (!subject) {
            return res.status(404).json({ success: false, message: 'Subject not found' });
        }

        const targetStatus = ratingEnabled !== undefined ? Boolean(ratingEnabled) : !subject.ratingEnabled;
        const escaped = subject.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Update all classes offering this subject name in current academic year
        const updateResult = await Subject.updateMany(
            {
                name: { $regex: new RegExp(`^${escaped}$`, 'i') },
                academicYear: req.academicYearContext
            },
            { $set: { ratingEnabled: targetStatus } }
        );

        res.json({
            success: true,
            message: `Student ratings ${targetStatus ? 'enabled' : 'disabled'} for "${subject.name}" across all ${updateResult.modifiedCount} class(es)`,
            subject: {
                _id: subject._id,
                name: subject.name,
                ratingEnabled: targetStatus,
                modifiedCount: updateResult.modifiedCount
            }
        });
    } catch (err) {
        console.error('Error toggling subject rating:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

router.route('/admin/subject/:subjectId/toggle-rating')
    .patch(auth, yearContext, requireAdmin, toggleRatingBySubjectIdHandler)
    .post(auth, yearContext, requireAdmin, toggleRatingBySubjectIdHandler)
    .put(auth, yearContext, requireAdmin, toggleRatingBySubjectIdHandler);

// @route   POST /api/student-ratings/admin/bulk-configure-ratings
// @desc    Bulk configure ratingEnabled school-wide (all subjects or list of subject names/ids)
// @access  Private (Admin)
router.post('/admin/bulk-configure-ratings', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (_) {}
        }
        const { subjectIds, subjectNames, all, ratingEnabled } = body || {};
        const isEnabled = Boolean(ratingEnabled);
        let filter = { academicYear: req.academicYearContext };

        if (all) {
            // update all subjects school-wide
        } else if (Array.isArray(subjectNames) && subjectNames.length > 0) {
            const regexes = subjectNames.map(n => {
                const escaped = n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`^${escaped}$`, 'i');
            });
            filter.name = { $in: regexes };
        } else if (Array.isArray(subjectIds) && subjectIds.length > 0) {
            // Find all subject names for these IDs, then update by names to affect all classes
            const sampleSubjects = await Subject.find({ _id: { $in: subjectIds } }).select('name').lean();
            const names = [...new Set(sampleSubjects.map(s => s.name.trim()))];
            const regexes = names.map(n => {
                const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`^${escaped}$`, 'i');
            });
            filter.name = { $in: regexes };
        } else {
            return res.status(400).json({ success: false, message: 'Must specify all: true, subjectNames, or subjectIds' });
        }

        const updateResult = await Subject.updateMany(filter, { $set: { ratingEnabled: isEnabled } });

        res.json({
            success: true,
            message: `Updated ratings configuration for ${updateResult.modifiedCount} subject instances`,
            ratingEnabled: isEnabled,
            modifiedCount: updateResult.modifiedCount
        });
    } catch (err) {
        console.error('Error bulk configuring subject ratings:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ──────────────────────────────────────────────
//  RATINGS DELETION & RESET HANDLERS
// ──────────────────────────────────────────────

/**
 * Admin bulk deletion handler for subject, class, or entire month.
 * Resiliently handles both JSON body and URL query parameters (in case proxy strips DELETE body).
 */
const bulkDeleteHandler = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
        }

        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (_) {}
        }
        const subjectId = body?.subjectId || req.query?.subjectId;
        const classId = body?.classId || req.query?.classId;
        const allInMonth = body?.allInMonth ?? (req.query?.allInMonth === 'true' || req.query?.allInMonth === true || false);
        const month = body?.month || req.query?.month;
        const year = body?.year || req.query?.year;
        const reason = body?.reason || req.query?.reason || 'Admin bulk deletion of mistaken ratings';

        const parsedMonth = parseInt(month, 10);
        const parsedYear = parseInt(year, 10);

        let filter = {
            month: parsedMonth,
            year: parsedYear
        };
        if (req.academicYearContext) {
            filter.academicYear = new mongoose.Types.ObjectId(req.academicYearContext);
        }

        let scopeLabel = `month ${MONTH_NAMES[parsedMonth - 1] || parsedMonth} ${parsedYear}`;
        let entityId = null;

        if (subjectId) {
            const subject = await Subject.findById(subjectId).populate('class', 'value label name section branch');
            if (!subject) {
                return res.status(404).json({ success: false, message: 'Subject not found' });
            }
            filter.subject = new mongoose.Types.ObjectId(subjectId);
            scopeLabel = `${subject.name} (${MONTH_NAMES[parsedMonth - 1] || parsedMonth} ${parsedYear})`;
            entityId = subject._id;
        } else if (classId) {
            const ClassModel = require('../models/Class');
            const targetClass = await ClassModel.findById(classId);
            if (!targetClass) {
                return res.status(404).json({ success: false, message: 'Class not found' });
            }
            filter.class = new mongoose.Types.ObjectId(classId);
            scopeLabel = `Class ${targetClass.label || targetClass.name} (${MONTH_NAMES[parsedMonth - 1] || parsedMonth} ${parsedYear})`;
            entityId = targetClass._id;
        }

        let existingCount = await StudentRating.countDocuments(filter);
        // Fallback: If 0 found with academicYear, check if ratings exist without academicYear constraint
        if (existingCount === 0 && filter.academicYear) {
            const fallbackFilter = { ...filter };
            delete fallbackFilter.academicYear;
            const fallbackCount = await StudentRating.countDocuments(fallbackFilter);
            if (fallbackCount > 0) {
                filter = fallbackFilter;
                existingCount = fallbackCount;
            }
        }

        if (existingCount === 0) {
            return res.status(404).json({
                success: false,
                message: `No ratings found for ${scopeLabel}`
            });
        }

        const deleteResult = await StudentRating.deleteMany(filter);

        // Audit Log
        await logAudit({
            req,
            action: 'RATINGS_BULK_DELETE',
            entityType: 'StudentRating',
            entityId,
            details: {
                subjectId,
                classId,
                allInMonth: Boolean(allInMonth),
                month: parsedMonth,
                year: parsedYear,
                deletedCount: deleteResult.deletedCount,
                reason
            }
        });

        // Invalidate cache
        await invalidateRatingCaches();

        return res.json({
            success: true,
            message: `Successfully deleted ${deleteResult.deletedCount} rating(s) for ${scopeLabel}.`,
            data: {
                deletedCount: deleteResult.deletedCount,
                subjectId,
                classId,
                allInMonth: Boolean(allInMonth),
                month: parsedMonth,
                year: parsedYear
            }
        });
    } catch (err) {
        console.error('Error bulk deleting student ratings:', err);
        return res.status(500).json({ success: false, message: 'Server error while deleting ratings' });
    }
};

// @route   DELETE /api/student-ratings/admin/bulk
// @desc    Admin bulk deletion of ratings for a subject, class, or entire month
// @access  Private (Admin / Super Admin)
router.delete('/admin/bulk', [auth, yearContext, requireOpenYear, requireAdmin, ...adminBulkDeleteValidation], bulkDeleteHandler);

// @route   POST /api/student-ratings/admin/bulk-delete
// @desc    Admin bulk deletion POST alias (ensures reliability across proxies/CDNs that strip DELETE body)
// @access  Private (Admin / Super Admin)
router.post('/admin/bulk-delete', [auth, yearContext, requireOpenYear, requireAdmin, ...adminBulkDeleteValidation], bulkDeleteHandler);

/**
 * Subject-level rating deletion handler for assigned teachers and admins.
 * Allows teachers to clear/reset mistaken ratings for their own subjects.
 */
const subjectResetHandler = async (req, res) => {
    try {
        const { subjectId } = req.params;
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (_) {}
        }
        const defaultMY = getISTMonthYear();
        const month = parseInt(body?.month || req.query?.month, 10) || defaultMY.month;
        const year = parseInt(body?.year || req.query?.year, 10) || defaultMY.year;
        const reason = body?.reason || req.query?.reason || 'Teacher/Admin reset ratings for subject';

        const subject = await Subject.findById(subjectId).populate('class', 'value label name section');
        if (!subject) {
            return res.status(404).json({ success: false, message: 'Subject not found' });
        }

        const isAdmin = req.user.role === 'admin' || req.user.role === 'super admin';
        const isSubjectTeacher = hasObjectIdMatch(subject.teachers, req.user.userId);

        if (!isAdmin && !isSubjectTeacher) {
            return res.status(403).json({ success: false, message: 'Not authorized to delete ratings for this subject' });
        }

        let filter = {
            subject: new mongoose.Types.ObjectId(subjectId),
            month,
            year
        };
        if (req.academicYearContext) {
            filter.academicYear = new mongoose.Types.ObjectId(req.academicYearContext);
        }

        let existingCount = await StudentRating.countDocuments(filter);
        if (existingCount === 0 && filter.academicYear) {
            delete filter.academicYear;
            existingCount = await StudentRating.countDocuments(filter);
        }

        if (existingCount === 0) {
            return res.status(404).json({
                success: false,
                message: `No ratings found for ${subject.name} in ${MONTH_NAMES[month - 1] || month} ${year}`
            });
        }

        const deleteResult = await StudentRating.deleteMany(filter);

        await logAudit({
            req,
            action: 'RATINGS_SUBJECT_RESET',
            entityType: 'Subject',
            entityId: subject._id,
            details: {
                subjectId,
                month,
                year,
                deletedCount: deleteResult.deletedCount,
                reason
            }
        });

        await invalidateRatingCaches();

        return res.json({
            success: true,
            message: `Successfully cleared ${deleteResult.deletedCount} rating(s) for ${subject.name}.`,
            data: {
                deletedCount: deleteResult.deletedCount,
                subjectId,
                month,
                year
            }
        });
    } catch (err) {
        console.error('Error resetting subject ratings:', err);
        return res.status(500).json({ success: false, message: 'Server error while resetting subject ratings' });
    }
};

// @route   DELETE /api/student-ratings/subject/:subjectId
// @desc    Reset/delete ratings for a subject (Teachers for their own subject, or Admins)
router.delete('/subject/:subjectId', [auth, yearContext, requireOpenYear], subjectResetHandler);
router.post('/subject/:subjectId/reset', [auth, yearContext, requireOpenYear], subjectResetHandler);

/**
 * Single student rating deletion handler.
 * Deletes rating for 1 student who was rated by mistake.
 */
const singleStudentDeleteHandler = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
        }

        const { studentId } = req.params;
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (_) {}
        }
        const subjectId = body?.subjectId || req.query?.subjectId;
        const month = parseInt(body?.month || req.query?.month, 10);
        const year = parseInt(body?.year || req.query?.year, 10);

        const subject = await Subject.findById(subjectId);
        if (!subject) {
            return res.status(404).json({ success: false, message: 'Subject not found' });
        }

        const isAdmin = req.user.role === 'admin' || req.user.role === 'super admin';
        const isSubjectTeacher = hasObjectIdMatch(subject.teachers, req.user.userId);

        if (!isAdmin && !isSubjectTeacher) {
            // Check if teacher is class teacher of the student
            const studentUser = await User.findById(studentId).select('currentClass');
            const ClassModel = require('../models/Class');
            const classObj = studentUser ? await ClassModel.findById(studentUser.currentClass) : null;
            const isClassTeacher = classObj && classObj.classTeacher && classObj.classTeacher.toString() === req.user.userId;
            if (!isClassTeacher) {
                return res.status(403).json({ success: false, message: 'Not authorized to delete ratings for this student' });
            }
        }

        let filter = {
            student: new mongoose.Types.ObjectId(studentId),
            subject: new mongoose.Types.ObjectId(subjectId),
            month,
            year
        };
        if (req.academicYearContext) {
            filter.academicYear = new mongoose.Types.ObjectId(req.academicYearContext);
        }

        let deletedDoc = await StudentRating.findOneAndDelete(filter);
        if (!deletedDoc && filter.academicYear) {
            delete filter.academicYear;
            deletedDoc = await StudentRating.findOneAndDelete(filter);
        }

        if (!deletedDoc) {
            return res.status(404).json({
                success: false,
                message: 'No existing rating found for this student to delete'
            });
        }

        await logAudit({
            req,
            action: 'RATINGS_SINGLE_DELETE',
            entityType: 'StudentRating',
            entityId: deletedDoc._id,
            details: {
                studentId,
                subjectId,
                month,
                year,
                previousScore: deletedDoc.averageScore
            }
        });

        await invalidateRatingCaches();

        return res.json({
            success: true,
            message: 'Student rating deleted successfully',
            data: {
                studentId,
                subjectId,
                month,
                year
            }
        });
    } catch (err) {
        console.error('Error deleting single student rating:', err);
        return res.status(500).json({ success: false, message: 'Server error while deleting student rating' });
    }
};

// @route   DELETE /api/student-ratings/student/:studentId
// @desc    Delete rating for a single student (Teachers for their subject, or Admins)
router.delete('/student/:studentId', [auth, yearContext, requireOpenYear, ...singleStudentRatingDeleteValidation], singleStudentDeleteHandler);
router.post('/student/:studentId/delete', [auth, yearContext, requireOpenYear, ...singleStudentRatingDeleteValidation], singleStudentDeleteHandler);

// @route   POST /api/student-ratings/admin/shift-month
// @desc    Admin correction: Move ratings from mistaken source month to target month (by subject, class, or entire month)
// @access  Private (Admin / Super Admin)
router.post('/admin/shift-month', [auth, yearContext, requireOpenYear, requireAdmin, ...adminShiftMonthValidation], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
        }

        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (_) {}
        }
        const {
            subjectId,
            classId,
            allInMonth = false,
            sourceMonth,
            sourceYear,
            targetMonth,
            targetYear,
            overwriteTarget = false,
            reason = ''
        } = body || {};

        const sMonth = parseInt(sourceMonth, 10);
        const sYear = parseInt(sourceYear, 10);
        const tMonth = parseInt(targetMonth, 10);
        const tYear = parseInt(targetYear, 10);

        if (sMonth === tMonth && sYear === tYear) {
            return res.status(400).json({
                success: false,
                message: 'Source month/year and target month/year cannot be identical'
            });
        }

        // Prevent moving to future months
        const istNow = getISTMonthYear();
        if (tYear > istNow.year || (tYear === istNow.year && tMonth > istNow.month)) {
            return res.status(400).json({
                success: false,
                message: 'Cannot move ratings to a future month.'
            });
        }

        let sourceFilter = {
            month: sMonth,
            year: sYear,
            academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
        };
        let targetFilter = {
            month: tMonth,
            year: tYear,
            academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
        };
        let scopeLabel = `ratings from ${MONTH_NAMES[sMonth - 1] || sMonth} ${sYear}`;
        let entityId = null;

        if (subjectId) {
            const subject = await Subject.findById(subjectId).populate('class', 'value label name section branch');
            if (!subject) {
                return res.status(404).json({ success: false, message: 'Subject not found' });
            }
            sourceFilter.subject = new mongoose.Types.ObjectId(subjectId);
            targetFilter.subject = new mongoose.Types.ObjectId(subjectId);
            scopeLabel = `${subject.name} ratings`;
            entityId = subject._id;
        } else if (classId) {
            const ClassModel = require('../models/Class');
            const targetClass = await ClassModel.findById(classId);
            if (!targetClass) {
                return res.status(404).json({ success: false, message: 'Class not found' });
            }
            sourceFilter.class = new mongoose.Types.ObjectId(classId);
            targetFilter.class = new mongoose.Types.ObjectId(classId);
            scopeLabel = `Class ${targetClass.label || targetClass.name} ratings`;
            entityId = targetClass._id;
        }

        let sourceCount = await StudentRating.countDocuments(sourceFilter);
        if (sourceCount === 0 && sourceFilter.academicYear) {
            delete sourceFilter.academicYear;
            sourceCount = await StudentRating.countDocuments(sourceFilter);
        }
        if (sourceCount === 0) {
            return res.status(404).json({
                success: false,
                message: `No ratings found in source period (${MONTH_NAMES[sMonth - 1] || sMonth} ${sYear}) to move.`
            });
        }

        const targetCount = await StudentRating.countDocuments(targetFilter);
        if (targetCount > 0 && !overwriteTarget) {
            return res.status(409).json({
                success: false,
                hasConflict: true,
                message: `Target period (${MONTH_NAMES[tMonth - 1] || tMonth} ${tYear}) already contains ${targetCount} rating(s). Enable overwrite to replace them.`,
                targetCount
            });
        }

        // If overwriteTarget is true and target has ratings, remove target ratings first to avoid duplicate key conflicts
        if (targetCount > 0 && overwriteTarget) {
            await StudentRating.deleteMany(targetFilter);
        }

        // Atomically update source ratings to target month/year
        const updateResult = await StudentRating.updateMany(sourceFilter, {
            $set: {
                month: tMonth,
                year: tYear,
                lastModifiedBy: new mongoose.Types.ObjectId(req.user.userId),
                updatedAt: new Date()
            }
        });

        // Audit Log
        await logAudit({
            req,
            action: 'RATINGS_MONTH_SHIFT',
            entityType: 'StudentRating',
            entityId,
            details: {
                subjectId,
                classId,
                allInMonth: Boolean(allInMonth),
                from: { month: sMonth, year: sYear },
                to: { month: tMonth, year: tYear },
                movedCount: updateResult.modifiedCount,
                overwrittenCount: targetCount > 0 && overwriteTarget ? targetCount : 0,
                reason
            }
        });

        // Invalidate Redis cache
        await invalidateRatingCaches();

        return res.json({
            success: true,
            message: `Successfully moved ${updateResult.modifiedCount} rating(s) (${scopeLabel}) from ${MONTH_NAMES[sMonth - 1] || sMonth} ${sYear} to ${MONTH_NAMES[tMonth - 1] || tMonth} ${tYear}.`,
            data: {
                movedCount: updateResult.modifiedCount,
                from: { month: sMonth, year: sYear },
                to: { month: tMonth, year: tYear },
                subjectId,
                classId,
                allInMonth: Boolean(allInMonth)
            }
        });
    } catch (err) {
        console.error('Error shifting student ratings month:', err);
        return res.status(500).json({ success: false, message: 'Server error while shifting ratings month' });
    }
});

// @route   GET /api/student-ratings/student/:studentId/trend
// @desc    Get monthly trend for a student (last N months)
// @access  Private (Admin/Teacher/Self-Student)
router.get('/student/:studentId/trend', [auth, yearContext], async (req, res) => {
    try {
        const { studentId } = req.params;
        const months = parseInt(req.query.months) || 6;

        // Security check: prevent cross-role student rating leaks
        const authorized = await canAccessStudentRatings(req.user, studentId, req.academicYearContext);
        if (!authorized) {
            return res.status(403).json({ success: false, message: 'Not authorized to view ratings for this student' });
        }

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
// @access  Private (Admin/Teacher/Self-Student)
router.get('/student/:studentId/details', [auth, yearContext], async (req, res) => {
    try {
        const { studentId } = req.params;
        const defaultMY = getPreviousMonthYear();
        const month = parseInt(req.query.month) || defaultMY.month;
        const year = parseInt(req.query.year) || defaultMY.year;

        // Security check: prevent cross-role student rating leaks
        const authorized = await canAccessStudentRatings(req.user, studentId, req.academicYearContext);
        if (!authorized) {
            return res.status(403).json({ success: false, message: 'Not authorized to view ratings for this student' });
        }

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
            .populate('subject', 'name ratingEnabled')
            .populate('teacher', 'name')
            .lean();

        // Compute overall averages per data point
        const scorableRatings = ratings.filter(r => !r.isExempt && r.averageScore != null && r.subject && r.subject.ratingEnabled !== false);
        let avgEngagement = 0, avgHomework = 0, avgBehaviour = 0, avgEnglish = 0;
        if (scorableRatings.length > 0) {
            avgEngagement = parseFloat((scorableRatings.reduce((s, r) => s + (r.classEngagement || 0), 0) / scorableRatings.length).toFixed(2));
            avgHomework = parseFloat((scorableRatings.reduce((s, r) => s + (r.homeworkClasswork || 0), 0) / scorableRatings.length).toFixed(2));
            avgBehaviour = parseFloat((scorableRatings.reduce((s, r) => s + (r.behaviourSocial || 0), 0) / scorableRatings.length).toFixed(2));
            avgEnglish = parseFloat((scorableRatings.reduce((s, r) => s + (r.englishComm || 0), 0) / scorableRatings.length).toFixed(2));
        }

        const overallAverage = scorableRatings.length > 0
            ? parseFloat((scorableRatings.reduce((s, r) => s + r.averageScore, 0) / scorableRatings.length).toFixed(2))
            : null;

        const evaluation = StudentRating.getPerformanceEvaluation(overallAverage);

        res.json({
            success: true,
            student,
            month,
            year,
            overallAverage,
            evaluation,
            dataPointAverages: {
                classEngagement: avgEngagement,
                homeworkClasswork: avgHomework,
                behaviourSocial: avgBehaviour,
                englishComm: avgEnglish
            },
            subjectRatings: ratings.map(r => ({
                subject: r.subject || { _id: null, name: r.subjectName || 'Subject', ratingEnabled: true },
                teacher: r.teacher || { name: 'Subject Teacher' },
                isExempt: Boolean(r.isExempt),
                exemptionReason: r.exemptionReason || '',
                remarks: r.remarks || '',
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

// @route   GET /api/student-ratings/school/all-students-dashboard
// @desc    Get cumulative school-wide comprehensive student leaderboard across marks (50%) & ratings (50%)
// @access  Private (Admin, Super Admin, Teacher, Staff, Support Staff)
router.get('/school/all-students-dashboard', [auth, yearContext, checkRole(['admin', 'super admin', 'teacher', 'staff', 'support_staff'])], async (req, res) => {
    try {
        const { classId, tier, search, sortBy, mode = 'comprehensive' } = req.query;
        const marksWeight = req.query.marksWeight !== undefined && !isNaN(Number(req.query.marksWeight))
            ? Number(req.query.marksWeight)
            : 50;
        const ratingsWeight = req.query.ratingsWeight !== undefined && !isNaN(Number(req.query.ratingsWeight))
            ? Number(req.query.ratingsWeight)
            : 50;

        const cacheKey = `student-ratings:dashboard:${req.academicYearContext}:${classId || 'all'}:${mode}:${marksWeight}:${ratingsWeight}:${search || ''}:${tier || 'all'}:${sortBy || ''}`;

        // 1. In-memory cache check (0ms)
        const memCached = dashboardCache.get(cacheKey);
        if (memCached && (Date.now() - memCached.ts < DASHBOARD_CACHE_TTL_MS)) {
            return res.json(memCached.data);
        }

        // 2. Redis cache check (~1ms)
        try {
            const redisData = await cacheGet(cacheKey);
            if (redisData) {
                dashboardCache.set(cacheKey, { data: redisData, ts: Date.now() });
                return res.json(redisData);
            }
        } catch (_) {}

        const Exam = require('../models/Exam');
        const Marks = require('../models/Marks');
        const ClassModel = require('../models/Class');
        const {
            getClassExamWeights,
            computeClassWeightedMarks,
            STANDARDIZED_EXAM_TYPES,
            EXAM_WEIGHTS_BY_CLASS
        } = require('../utils/examWeightResolver');

        // 1. Fetch active enrolled students in the target academic year (and class if filtered)
        const enrolledQuery = {
            role: 'student',
            academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
            isActive: true
        };
        if (classId && classId !== 'all') {
            enrolledQuery.currentClass = new mongoose.Types.ObjectId(classId);
        }

        const enrolledStudents = await User.find(enrolledQuery)
            .select('_id name gender regNo profilePhoto currentClass rollNumber')
            .populate('currentClass', 'label name section branch value examWeights')
            .lean();

        const totalEnrolledStudents = enrolledStudents.length;
        const studentIds = enrolledStudents.map(s => s._id);

        const studentClassById = {};
        enrolledStudents.forEach(s => {
            if (s.currentClass && s.currentClass._id) {
                studentClassById[s._id.toString()] = s.currentClass._id.toString();
            }
        });

        // 2. Aggregate monthly ratings for these students
        const ratingsFilter = {
            academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
            isExempt: { $ne: true },
            averageScore: { $ne: null },
            student: { $in: studentIds }
        };

        const ratingAggregations = await StudentRating.aggregate([
            { $match: ratingsFilter },
            {
                $group: {
                    _id: '$student',
                    overallAverage: { $avg: '$averageScore' },
                    avgClassEngagement: { $avg: '$classEngagement' },
                    avgHomeworkClasswork: { $avg: '$homeworkClasswork' },
                    avgBehaviourSocial: { $avg: '$behaviourSocial' },
                    avgEnglishComm: { $avg: '$englishComm' },
                    totalRatings: { $sum: 1 },
                    evaluatedMonths: { $addToSet: { month: '$month', year: '$year' } },
                    monthlyScores: {
                        $push: {
                            month: '$month',
                            year: '$year',
                            averageScore: '$averageScore'
                        }
                    }
                }
            }
        ]);

        const ratingsByStudent = {};
        ratingAggregations.forEach(r => {
            ratingsByStudent[r._id.toString()] = r;
        });

        // 3. Fetch standardized exams for this academic year (and class if filtered)
        const yearId = req.academicYearContext;
        const examFilter = {
            status: { $ne: 'cancelled' },
            $or: [
                { isStandardized: true },
                { standardizedType: { $in: STANDARDIZED_EXAM_TYPES } }
            ]
        };
        if (yearId) {
            examFilter.academicYear = { $in: [yearId, new mongoose.Types.ObjectId(yearId)] };
        }
        if (classId && classId !== 'all') {
            examFilter.class = { $in: [classId, new mongoose.Types.ObjectId(classId)] };
        }
        let exams = await Exam.find(examFilter)
            .select('_id name standardizedType class subject totalMarks isStandardized status academicYear')
            .lean();

        // If no exams found for this year context, fallback to exams with unset/null academicYear
        if (exams.length === 0 && yearId) {
            const fallbackFilter = {
                status: { $ne: 'cancelled' },
                $or: [
                    { isStandardized: true },
                    { standardizedType: { $in: STANDARDIZED_EXAM_TYPES } }
                ]
            };
            if (classId && classId !== 'all') {
                fallbackFilter.class = { $in: [classId, new mongoose.Types.ObjectId(classId)] };
            }
            const fallbackExams = await Exam.find(fallbackFilter)
                .select('_id name standardizedType class subject totalMarks isStandardized status academicYear')
                .lean();
            if (fallbackExams.length > 0) {
                exams = fallbackExams;
            }
        }

        const examIds = exams.map(e => e._id);
        const examById = {};
        exams.forEach(e => {
            examById[e._id.toString()] = e;
        });

        // 4. Fetch all marks entered for these exams
        const marksRecords = await Marks.find({
            exam: { $in: examIds },
            student: { $in: studentIds }
        }).select('student exam marksObtained percentage').lean();

        // Standardized Exam Type Normalizer
        const resolveExamType = (e) => {
            if (!e) return null;
            const direct = (e.standardizedType || '').toUpperCase().trim();
            if (STANDARDIZED_EXAM_TYPES.includes(direct)) return direct;
            const clean = `${e.standardizedType || ''} ${e.name || ''}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
            for (const t of STANDARDIZED_EXAM_TYPES) {
                if (clean.includes(t)) return t;
            }
            return null;
        };

        // Group marks by student and standardized exam type
        const marksByStudent = {};
        marksRecords.forEach(m => {
            const studentIdStr = (m.student?._id || m.student).toString();
            const examIdStr = (m.exam?._id || m.exam).toString();
            const exam = examById[examIdStr];
            if (!exam) return;

            const stdType = resolveExamType(exam);
            if (!stdType) return;

            if (!marksByStudent[studentIdStr]) {
                marksByStudent[studentIdStr] = {};
            }
            if (!marksByStudent[studentIdStr][stdType]) {
                marksByStudent[studentIdStr][stdType] = {
                    totalObtained: 0,
                    totalMax: 0,
                    count: 0
                };
            }

            const examMaxMarks = (typeof exam.totalMarks === 'number' && exam.totalMarks > 0)
                ? exam.totalMarks
                : (Number(exam.totalMarks) > 0 ? Number(exam.totalMarks) : 100);

            const studentObtained = (typeof m.marksObtained === 'number' && !isNaN(m.marksObtained))
                ? m.marksObtained
                : (Number(m.marksObtained) >= 0 ? Number(m.marksObtained) : 0);

            marksByStudent[studentIdStr][stdType].totalObtained += studentObtained;
            marksByStudent[studentIdStr][stdType].totalMax += examMaxMarks;
            marksByStudent[studentIdStr][stdType].count += 1;
        });

        // 5. Process each student: calculate class-specific weighted marks, rating scores, and 50/50 composite score
        const processedStudents = enrolledStudents.map(studentDoc => {
            const studentIdStr = studentDoc._id.toString();
            const ratingData = ratingsByStudent[studentIdStr];
            const studentMarksData = marksByStudent[studentIdStr] || {};
            const classObj = studentDoc.currentClass;

            // Class-specific exam weights (Class 1, 2, 3 have distinct configs; class DB weights override)
            const classExamWeights = getClassExamWeights(classObj);

            // Compute exam scores and breakdown
            const completedTypeScores = {};
            const examBreakdown = [];

            STANDARDIZED_EXAM_TYPES.forEach(type => {
                const typeData = studentMarksData[type];
                const weight = classExamWeights[type] || 0;
                if (typeData && typeData.totalMax > 0) {
                    const pct = parseFloat(((typeData.totalObtained / typeData.totalMax) * 100).toFixed(1));
                    completedTypeScores[type] = pct;
                    examBreakdown.push({
                        type,
                        weight,
                        totalObtained: typeData.totalObtained,
                        totalMax: typeData.totalMax,
                        percentage: pct
                    });
                } else {
                    examBreakdown.push({
                        type,
                        weight,
                        totalObtained: null,
                        totalMax: null,
                        percentage: null
                    });
                }
            });

            const marksScore = computeClassWeightedMarks(completedTypeScores, classExamWeights);

            // Rating calculations
            let overallAvg = null;
            let ratingsScore = null;
            let evalCategory = null;
            let trendDirection = 'stable';
            let changeVal = 0;
            let totalRatings = 0;
            let monthsCount = 0;
            let avgClassEngagement = null;
            let avgHomeworkClasswork = null;
            let avgBehaviourSocial = null;
            let avgEnglishComm = null;

            if (ratingData) {
                overallAvg = parseFloat(ratingData.overallAverage.toFixed(2));
                // Rating normalized to 100%: (average / 5.0) * 100
                ratingsScore = parseFloat(((overallAvg / 5.0) * 100).toFixed(1));
                evalCategory = StudentRating.getPerformanceEvaluation(overallAvg);
                totalRatings = ratingData.totalRatings;
                monthsCount = ratingData.evaluatedMonths.length;
                avgClassEngagement = parseFloat(ratingData.avgClassEngagement.toFixed(2));
                avgHomeworkClasswork = parseFloat(ratingData.avgHomeworkClasswork.toFixed(2));
                avgBehaviourSocial = parseFloat(ratingData.avgBehaviourSocial.toFixed(2));
                avgEnglishComm = parseFloat(ratingData.avgEnglishComm.toFixed(2));

                // Trend calculation across months
                if (ratingData.monthlyScores && ratingData.monthlyScores.length > 1) {
                    const monthAverages = {};
                    ratingData.monthlyScores.forEach(ms => {
                        const key = `${ms.year}-${String(ms.month).padStart(2, '0')}`;
                        if (!monthAverages[key]) {
                            monthAverages[key] = { key, scores: [] };
                        }
                        monthAverages[key].scores.push(ms.averageScore);
                    });
                    const sortedMonths = Object.values(monthAverages)
                        .map(m => ({
                            key: m.key,
                            avg: m.scores.reduce((a, b) => a + b, 0) / m.scores.length
                        }))
                        .sort((a, b) => a.key.localeCompare(b.key));

                    if (sortedMonths.length >= 2) {
                        const latest = sortedMonths[sortedMonths.length - 1].avg;
                        const prev = sortedMonths[sortedMonths.length - 2].avg;
                        changeVal = parseFloat((latest - prev).toFixed(2));
                        if (changeVal > 0.25) trendDirection = 'improving';
                        else if (changeVal < -0.25) trendDirection = 'declining';
                    }
                }
            }

            // 50/50 Composite Score Calculation
            let compositeScore = null;
            let evaluationStatus = 'unrated'; // 'complete' | 'marks_only' | 'ratings_only' | 'unrated'

            if (marksScore !== null && ratingsScore !== null) {
                const totalWeights = marksWeight + ratingsWeight;
                compositeScore = parseFloat(
                    (((marksWeight * marksScore) + (ratingsWeight * ratingsScore)) / totalWeights).toFixed(2)
                );
                evaluationStatus = 'complete';
            } else if (marksScore !== null) {
                compositeScore = marksScore;
                evaluationStatus = 'marks_only';
            } else if (ratingsScore !== null) {
                compositeScore = ratingsScore;
                evaluationStatus = 'ratings_only';
            }

            // Quadrant Placement:
            // High Marks threshold: >= 75%
            // High Ratings threshold: >= 3.5 stars (70%)
            let quadrant = 'needs_support';
            const isHighMarks = marksScore !== null && marksScore >= 75;
            const isHighRatings = overallAvg !== null && overallAvg >= 3.5;

            if (marksScore !== null && overallAvg !== null) {
                if (isHighMarks && isHighRatings) quadrant = 'all_rounder';
                else if (isHighMarks && !isHighRatings) quadrant = 'academic_star';
                else if (!isHighMarks && isHighRatings) quadrant = 'diligent_striver';
                else quadrant = 'needs_support';
            } else if (isHighMarks) {
                quadrant = 'academic_star';
            } else if (isHighRatings) {
                quadrant = 'diligent_striver';
            }

            return {
                student: {
                    _id: studentDoc._id,
                    name: studentDoc.name,
                    gender: studentDoc.gender,
                    regNo: studentDoc.regNo,
                    rollNumber: studentDoc.rollNumber,
                    profilePhoto: studentDoc.profilePhoto
                },
                class: classObj ? {
                    _id: classObj._id,
                    label: classObj.label,
                    name: classObj.name,
                    section: classObj.section,
                    branch: classObj.branch,
                    value: classObj.value
                } : null,
                classExamWeights,
                // Composite & Dimension Scores
                compositeScore,
                marksScore,
                ratingsScore,
                overallAverage: overallAvg, // Star rating (1-5) for backward compatibility
                evaluation: evalCategory,
                evaluationStatus,
                quadrant,
                examBreakdown,
                completedExamsCount: Object.keys(completedTypeScores).length,
                // Ratings pillars
                avgClassEngagement,
                avgHomeworkClasswork,
                avgBehaviourSocial,
                avgEnglishComm,
                totalRatings,
                monthsCount,
                trendDirection,
                trendChange: changeVal
            };
        });

        // 6. Filter evaluated students for base ranking
        const evaluatedStudents = processedStudents.filter(s => s.compositeScore !== null);
        const totalEvaluated = evaluatedStudents.length;

        // Establish component-specific ranks
        const sortedByMarks = [...evaluatedStudents].filter(s => s.marksScore !== null)
            .sort((a, b) => b.marksScore - a.marksScore);
        sortedByMarks.forEach((s, idx) => { s.marksRank = idx + 1; });

        const sortedByRatings = [...evaluatedStudents].filter(s => s.overallAverage !== null)
            .sort((a, b) => b.overallAverage - a.overallAverage);
        sortedByRatings.forEach((s, idx) => { s.ratingsRank = idx + 1; });

        // Base Leaderboard Sort: Default to comprehensive compositeScore descending
        processedStudents.sort((a, b) => {
            const scoreA = a.compositeScore !== null ? a.compositeScore : -1;
            const scoreB = b.compositeScore !== null ? b.compositeScore : -1;
            if (scoreB !== scoreA) {
                return scoreB - scoreA;
            }
            if ((b.marksScore || 0) !== (a.marksScore || 0)) {
                return (b.marksScore || 0) - (a.marksScore || 0);
            }
            return (b.overallAverage || 0) - (a.overallAverage || 0);
        });

        // Assign Overall Leaderboard Rank & Medal
        let rankCounter = 1;
        processedStudents.forEach((st) => {
            if (st.compositeScore !== null) {
                st.rank = rankCounter++;
                if (st.rank === 1) st.medal = 'gold';
                else if (st.rank === 2) st.medal = 'silver';
                else if (st.rank === 3) st.medal = 'bronze';
                else st.medal = null;
            } else {
                st.rank = null;
                st.medal = null;
            }
        });

        // Compute School-Wide / Selection-Wide Cumulative KPIs
        const studentsWithRatings = processedStudents.filter(s => s.overallAverage !== null);
        const schoolAverage = studentsWithRatings.length > 0
            ? parseFloat((studentsWithRatings.reduce((acc, st) => acc + st.overallAverage, 0) / studentsWithRatings.length).toFixed(2))
            : null;

        const studentsWithMarks = processedStudents.filter(s => s.marksScore !== null);
        const schoolMarksAverage = studentsWithMarks.length > 0
            ? parseFloat((studentsWithMarks.reduce((acc, st) => acc + st.marksScore, 0) / studentsWithMarks.length).toFixed(1))
            : null;

        const schoolCompositeAverage = totalEvaluated > 0
            ? parseFloat((evaluatedStudents.reduce((acc, st) => acc + st.compositeScore, 0) / totalEvaluated).toFixed(1))
            : null;

        const schoolCriteriaAverages = {
            classEngagement: studentsWithRatings.length > 0
                ? parseFloat((studentsWithRatings.reduce((acc, st) => acc + (st.avgClassEngagement || 0), 0) / studentsWithRatings.length).toFixed(2))
                : 0,
            homeworkClasswork: studentsWithRatings.length > 0
                ? parseFloat((studentsWithRatings.reduce((acc, st) => acc + (st.avgHomeworkClasswork || 0), 0) / studentsWithRatings.length).toFixed(2))
                : 0,
            behaviourSocial: studentsWithRatings.length > 0
                ? parseFloat((studentsWithRatings.reduce((acc, st) => acc + (st.avgBehaviourSocial || 0), 0) / studentsWithRatings.length).toFixed(2))
                : 0,
            englishComm: studentsWithRatings.length > 0
                ? parseFloat((studentsWithRatings.reduce((acc, st) => acc + (st.avgEnglishComm || 0), 0) / studentsWithRatings.length).toFixed(2))
                : 0
        };

        // Distribution tiers counts
        const tierCounts = {
            excellent: processedStudents.filter(s => (s.overallAverage || 0) >= 4.5).length,
            good: processedStudents.filter(s => (s.overallAverage || 0) >= 3.5 && (s.overallAverage || 0) < 4.5).length,
            meets: processedStudents.filter(s => (s.overallAverage || 0) >= 2.5 && (s.overallAverage || 0) < 3.5).length,
            needs_improvement: processedStudents.filter(s => s.overallAverage !== null && s.overallAverage >= 2.0 && s.overallAverage < 2.5).length,
            needs_significant_improvement: processedStudents.filter(s => s.overallAverage !== null && s.overallAverage < 2.0).length,
            unrated: Math.max(0, totalEnrolledStudents - totalEvaluated)
        };

        // Quadrant counts for filtering
        const quadrantCounts = {
            all_rounders: processedStudents.filter(s => s.quadrant === 'all_rounder').length,
            academic_stars: processedStudents.filter(s => s.quadrant === 'academic_star').length,
            diligent_strivers: processedStudents.filter(s => s.quadrant === 'diligent_striver').length,
            needs_support: processedStudents.filter(s => s.quadrant === 'needs_support').length
        };

        // Filter and sort for the response
        let filteredStudents = [...processedStudents];

        // Apply Search Filter (Name, RegNo, RollNumber)
        if (search && search.trim()) {
            const q = search.trim().toLowerCase();
            filteredStudents = filteredStudents.filter(s => {
                const name = (s.student?.name || '').toLowerCase();
                const regNo = (s.student?.regNo || '').toLowerCase();
                const roll = String(s.student?.rollNumber || '').toLowerCase();
                return name.includes(q) || regNo.includes(q) || roll.includes(q);
            });
        }

        // Apply Tier / Quadrant Filter
        if (tier && tier !== 'all') {
            if (tier === 'all_rounders') {
                filteredStudents = filteredStudents.filter(s => s.quadrant === 'all_rounder');
            } else if (tier === 'academic_stars') {
                filteredStudents = filteredStudents.filter(s => s.quadrant === 'academic_star');
            } else if (tier === 'diligent_strivers') {
                filteredStudents = filteredStudents.filter(s => s.quadrant === 'diligent_striver');
            } else if (tier === 'needs_support') {
                filteredStudents = filteredStudents.filter(s => s.quadrant === 'needs_support');
            } else if (tier === 'top_academics') {
                filteredStudents = filteredStudents.filter(s => (s.marksScore || 0) >= 80);
            } else if (tier === 'top_performers' || tier === 'excellent') {
                filteredStudents = filteredStudents.filter(s => (s.overallAverage || 0) >= 4.5);
            } else if (tier === 'good') {
                filteredStudents = filteredStudents.filter(s => (s.overallAverage || 0) >= 3.5 && (s.overallAverage || 0) < 4.5);
            } else if (tier === 'meets') {
                filteredStudents = filteredStudents.filter(s => (s.overallAverage || 0) >= 2.5 && (s.overallAverage || 0) < 3.5);
            } else if (tier === 'attention' || tier === 'needs_attention') {
                filteredStudents = filteredStudents.filter(s => s.overallAverage !== null && s.overallAverage < 3.0);
            } else if (tier === 'needs_improvement') {
                filteredStudents = filteredStudents.filter(s => s.overallAverage !== null && s.overallAverage >= 2.0 && s.overallAverage < 2.5);
            } else if (tier === 'needs_significant_improvement') {
                filteredStudents = filteredStudents.filter(s => s.overallAverage !== null && s.overallAverage < 2.0);
            }
        }

        // Apply Custom Sort
        const activeSort = sortBy || (mode === 'marks' ? 'marks' : mode === 'ratings' ? 'ratings' : 'composite');

        if (activeSort === 'marks') {
            filteredStudents.sort((a, b) => (b.marksScore || -1) - (a.marksScore || -1));
        } else if (activeSort === 'ratings' || activeSort === 'highest') {
            filteredStudents.sort((a, b) => (b.overallAverage || -1) - (a.overallAverage || -1));
        } else if (activeSort === 'lowest') {
            filteredStudents.sort((a, b) => (a.compositeScore !== null ? a.compositeScore : 999) - (b.compositeScore !== null ? b.compositeScore : 999));
        } else if (activeSort === 'name') {
            filteredStudents.sort((a, b) => (a.student?.name || '').localeCompare(b.student?.name || ''));
        } else if (activeSort === 'most_rated') {
            filteredStudents.sort((a, b) => b.totalRatings - a.totalRatings);
        } else if (activeSort === 'least_rated') {
            filteredStudents.sort((a, b) => a.totalRatings - b.totalRatings);
        } else if (activeSort === 'improving') {
            filteredStudents.sort((a, b) => (b.trendChange || 0) - (a.trendChange || 0));
        }

        // Fetch distinct classes for filter dropdown
        const classes = await ClassModel.find({ academicYear: req.academicYearContext })
            .select('value label name section branch examWeights')
            .sort({ value: 1, section: 1 })
            .lean();

        const responseData = {
            success: true,
            mode,
            marksWeight,
            ratingsWeight,
            schoolCompositeAverage,
            schoolMarksAverage,
            schoolAverage, // backward compatible rating average
            schoolRatingAverage: schoolAverage,
            totalEnrolledStudents,
            totalEvaluatedStudents: totalEvaluated,
            evaluationCoveragePercent: totalEnrolledStudents > 0
                ? Math.round((totalEvaluated / totalEnrolledStudents) * 100)
                : 0,
            schoolCriteriaAverages,
            tierCounts,
            quadrantCounts,
            defaultWeightsByClass: EXAM_WEIGHTS_BY_CLASS,
            totalStudentsCount: filteredStudents.length,
            students: filteredStudents,
            classes,
            dataPoints: StudentRating.DATA_POINTS,
            ratingLabels: StudentRating.RATING_LABELS
        };

        // Cache response in memory and Redis
        dashboardCache.set(cacheKey, { data: responseData, ts: Date.now() });
        cacheSet(cacheKey, responseData, DASHBOARD_REDIS_TTL_SEC).catch(() => {});

        res.json(responseData);
    } catch (err) {
        console.error('Error fetching school all-students dashboard:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/student-ratings/school/summary
// @desc    Get school-wide summary — class averages comparison
// @access  Private (Admin)
router.get('/school/summary', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        const defaultMY = getPreviousMonthYear();
        const month = parseInt(req.query.month) || defaultMY.month;
        const year = parseInt(req.query.year) || defaultMY.year;

        const classAverages = await StudentRating.aggregate([
            {
                $match: {
                    month,
                    year,
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
                    isExempt: { $ne: true },
                    averageScore: { $ne: null }
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
        const defaultMY = getPreviousMonthYear();
        const month = parseInt(req.query.month) || defaultMY.month;
        const year = parseInt(req.query.year) || defaultMY.year;
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
            isExempt: { $ne: true },
            averageScore: { $ne: null },
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
                    subjectCount: { $sum: 1 },
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
                            avgScore: '$avgScore',
                            subjectCount: '$subjectCount'
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
                currentSubjectCount: current.subjectCount,
                previousSubjectCount: previous.subjectCount,
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
        const istNow = getISTMonthYear();
        const month = parseInt(req.query.month) || istNow.month;
        const year = parseInt(req.query.year) || istNow.year;
        const isPastMonth = year < istNow.year || (year === istNow.year && month < istNow.month);

        // Get all subjects for the academic year with their teachers and classes (ONLY ratable subjects)
        const allSubjects = await Subject.find({
            academicYear: req.academicYearContext,
            ratingEnabled: { $ne: false } // Crucial: exclude non-ratable subjects!
        })
            .populate('class', 'value label name section branch')
            .populate('teachers', 'name designation profilePhoto')
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

        // Get rating counts per subject (evaluated at subject level to fix co-teacher lockout)
        const ratableSubjectIds = validSubjects.map(s => s._id);
        const ratingCounts = await StudentRating.aggregate([
            {
                $match: {
                    month,
                    year,
                    academicYear: new mongoose.Types.ObjectId(req.academicYearContext),
                    subject: { $in: ratableSubjectIds }
                }
            },
            {
                $group: {
                    _id: '$subject',
                    count: { $sum: 1 },
                    teachers: { $addToSet: '$teacher' }
                }
            }
        ]);
        const subjectRatingMap = {};
        ratingCounts.forEach(rc => {
            subjectRatingMap[rc._id.toString()] = {
                count: rc.count,
                teachers: rc.teachers || []
            };
        });

        // Filter out empty classes (0 students and 0 ratings) to avoid false misses
        const ratableSubjects = validSubjects.filter(s => {
            const studentCount = studentCountMap[s.class._id.toString()] || 0;
            const rData = subjectRatingMap[s._id.toString()];
            return studentCount > 0 || (rData && rData.count > 0);
        });

        // Build teacher-wise view and class-wise view
        const teacherMap = {};
        const classMap = {};

        ratableSubjects.forEach(subject => {
            const classIdStr = subject.class._id.toString();
            const totalStudents = studentCountMap[classIdStr] || 0;
            const rData = subjectRatingMap[subject._id.toString()] || { count: 0, teachers: [] };
            const ratedCount = rData.count;
            const isCompleted = totalStudents > 0 && ratedCount >= totalStudents;
            const status = isCompleted ? 'submitted' : (isPastMonth ? 'missed' : 'pending');

            // Class breakdown
            if (!classMap[classIdStr]) {
                classMap[classIdStr] = {
                    class: subject.class,
                    totalSubjects: 0,
                    completedSubjects: 0,
                    pendingSubjects: 0,
                    missedSubjects: 0,
                    subjects: []
                };
            }
            classMap[classIdStr].totalSubjects += 1;
            if (isCompleted) classMap[classIdStr].completedSubjects += 1;
            else if (isPastMonth) classMap[classIdStr].missedSubjects += 1;
            else classMap[classIdStr].pendingSubjects += 1;

            classMap[classIdStr].subjects.push({
                subject: { _id: subject._id, name: subject.name },
                class: subject.class,
                totalStudents,
                ratedCount,
                status,
                teachers: subject.teachers || []
            });

            // Teacher breakdown
            (subject.teachers || []).forEach(teacher => {
                if (!teacher) return;
                const teacherId = teacher._id.toString();

                if (!teacherMap[teacherId]) {
                    teacherMap[teacherId] = {
                        teacher: { _id: teacher._id, name: teacher.name, designation: teacher.designation },
                        total: 0,
                        completed: 0,
                        pending: 0,
                        missed: 0,
                        subjects: []
                    };
                }

                teacherMap[teacherId].total += 1;
                if (isCompleted) {
                    teacherMap[teacherId].completed += 1;
                } else if (isPastMonth) {
                    teacherMap[teacherId].missed += 1;
                } else {
                    teacherMap[teacherId].pending += 1;
                }

                teacherMap[teacherId].subjects.push({
                    subject: { _id: subject._id, name: subject.name },
                    class: subject.class,
                    totalStudents,
                    ratedCount,
                    status
                });
            });
        });

        const teachers = Object.values(teacherMap).sort((a, b) => {
            const aIncomplete = a.pending + a.missed;
            const bIncomplete = b.pending + b.missed;
            if (aIncomplete !== bIncomplete) return bIncomplete - aIncomplete;
            return a.teacher.name.localeCompare(b.teacher.name);
        });

        const classes = Object.values(classMap).sort((a, b) => {
            const aIncomplete = a.pendingSubjects + a.missedSubjects;
            const bIncomplete = b.pendingSubjects + b.missedSubjects;
            if (aIncomplete !== bIncomplete) return bIncomplete - aIncomplete;
            return (a.class.label || '').localeCompare(b.class.label || '');
        });

        const totalSubjects = ratableSubjects.length;
        const totalCompleted = ratableSubjects.filter(s => {
            const totalStudents = studentCountMap[s.class._id.toString()] || 0;
            const ratedCount = (subjectRatingMap[s._id.toString()] || {}).count || 0;
            return totalStudents > 0 && ratedCount >= totalStudents;
        }).length;

        const totalMissed = isPastMonth ? (totalSubjects - totalCompleted) : 0;
        const totalPending = isPastMonth ? 0 : (totalSubjects - totalCompleted);

        res.json({
            success: true,
            type: 'ratings',
            month,
            year,
            isPastMonth,
            overall: {
                total: totalSubjects,
                completed: totalCompleted,
                pending: totalPending,
                missed: totalMissed,
                percentage: totalSubjects > 0
                    ? Math.round((totalCompleted / totalSubjects) * 100)
                    : 0
            },
            teachers,
            classes
        });
    } catch (err) {
        console.error('Error fetching rating tracker:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// @route   GET /api/student-ratings/tracker/my-status
// @desc    Get teacher's own submission status for the tracker
// @access  Private (Teacher)
router.get('/tracker/my-status', [auth, yearContext, checkRole(['teacher', 'staff', 'support_staff', 'admin', 'super admin'])], async (req, res) => {
    try {
        const userId = req.user.userId;
        const istNow = getISTMonthYear();
        const month = parseInt(req.query.month) || istNow.month;
        const year = parseInt(req.query.year) || istNow.year;
        const isPastMonth = year < istNow.year || (year === istNow.year && month < istNow.month);

        // Get subjects this teacher teaches that have ratings enabled
        let subjects = await Subject.find({
            teachers: userId,
            academicYear: req.academicYearContext,
            ratingEnabled: { $ne: false } // Crucial: exclude non-ratable subjects
        })
            .populate('class', 'value label name section branch')
            .sort({ name: 1 });

        subjects = subjects.filter(s => s.class);
        const subjectIds = subjects.map(s => s._id);

        // Get existing rating counts (at subject level)
        const ratingCounts = await StudentRating.aggregate([
            {
                $match: {
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
        let missed = 0;
        let pending = 0;

        const subjectStatuses = subjects
            .filter(subject => {
                const totalStudents = studentCountMap[subject.class._id.toString()] || 0;
                const ratedCount = ratingCountMap[subject._id.toString()] || 0;
                return totalStudents > 0 || ratedCount > 0;
            })
            .map(subject => {
                const totalStudents = studentCountMap[subject.class._id.toString()] || 0;
                const ratedCount = ratingCountMap[subject._id.toString()] || 0;
                const isCompleted = totalStudents > 0 && ratedCount >= totalStudents;
                const status = isCompleted ? 'submitted' : (isPastMonth ? 'missed' : 'pending');

                if (isCompleted) completed += 1;
                else if (isPastMonth) missed += 1;
                else pending += 1;

                return {
                    subject: { _id: subject._id, name: subject.name },
                    class: subject.class,
                    totalStudents,
                    ratedCount,
                    status
                };
            });

        res.json({
            success: true,
            month,
            year,
            isPastMonth,
            total: subjectStatuses.length,
            completed,
            pending,
            missed,
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
