const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { validationResult } = require('express-validator');
const { authenticateToken: auth, requireAdmin, checkRole } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');
const StudentRating = require('../models/StudentRating');
const Subject = require('../models/Subject');
const User = require('../models/User');
const { bulkRatingValidation } = require('../validations/studentRating');

const hasObjectIdMatch = (ids = [], userId) => ids.some((id) => id && id.toString() === userId);

/**
 * Validates cross-role access to individual student ratings to prevent information leaks.
 * - Admin/Super Admin: allowed.
 * - Student: allowed only for their own userId.
 * - Teacher: allowed if assigned as class teacher or subject teacher for the student's class.
 */
const canAccessStudentRatings = async (callerUser, targetStudentId, academicYearContext) => {
    if (!callerUser) return false;
    const role = callerUser.role;
    if (role === 'admin' || role === 'super admin') {
        return true;
    }
    if (role === 'student') {
        return callerUser.userId === targetStudentId.toString();
    }
    if (role === 'teacher' || role === 'staff' || role === 'support_staff') {
        const targetStudent = await User.findById(targetStudentId).select('currentClass').lean();
        if (!targetStudent || !targetStudent.currentClass) return false;

        const ClassModel = require('../models/Class');
        const isClassTeacher = await ClassModel.exists({
            _id: targetStudent.currentClass,
            classTeacher: callerUser.userId
        });
        if (isClassTeacher) return true;

        const isSubjectTeacher = await Subject.exists({
            class: targetStudent.currentClass,
            teachers: callerUser.userId,
            academicYear: academicYearContext
        });
        return !!isSubjectTeacher;
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
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const now = new Date();
        const isPastMonth = year < now.getFullYear() || (year === now.getFullYear() && month < (now.getMonth() + 1));

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

        // Build response
        const subjectsWithStatus = subjects.map(subject => {
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

// ──────────────────────────────────────────────
//  STUDENT SELF-SERVICE ENDPOINTS
// ──────────────────────────────────────────────

// @route   GET /api/student-ratings/my-ratings
// @desc    Get logged-in student's ratings, monthly average, criteria breakdown, trend and subject breakdown
// @access  Private (Student)
router.get('/my-ratings', [auth, yearContext, checkRole(['student'])], async (req, res) => {
    try {
        const studentId = req.user.userId;
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

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

        // Filter ratings to only enabled subjects (or where rating exists)
        const validRatings = ratings.filter(r => r.subject && r.subject.ratingEnabled !== false);

        // 4. Compute overall and criteria averages
        let avgEngagement = 0, avgHomework = 0, avgBehaviour = 0, avgEnglish = 0, overallAverage = null;
        if (validRatings.length > 0) {
            avgEngagement = parseFloat((validRatings.reduce((s, r) => s + r.classEngagement, 0) / validRatings.length).toFixed(2));
            avgHomework = parseFloat((validRatings.reduce((s, r) => s + r.homeworkClasswork, 0) / validRatings.length).toFixed(2));
            avgBehaviour = parseFloat((validRatings.reduce((s, r) => s + r.behaviourSocial, 0) / validRatings.length).toFixed(2));
            avgEnglish = parseFloat((validRatings.reduce((s, r) => s + r.englishComm, 0) / validRatings.length).toFixed(2));
            overallAverage = parseFloat((validRatings.reduce((s, r) => s + r.averageScore, 0) / validRatings.length).toFixed(2));
        }

        // 5. Subject breakdown list (including ratable subjects with rating or marked unrated)
        const ratingMap = {};
        validRatings.forEach(r => {
            ratingMap[r.subject._id.toString()] = r;
        });

        const subjectBreakdown = classSubjects
            .filter(s => s.ratingEnabled !== false) // Only ratable subjects
            .map(sub => {
                const r = ratingMap[sub._id.toString()];
                return {
                    subjectId: sub._id,
                    subjectName: sub.name,
                    isRated: !!r,
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
                        academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
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

        // 7. Student trend (last 6 months in academic year)
        const allStudentRatings = await StudentRating.find({
            student: studentId,
            academicYear: req.academicYearContext
        })
            .populate('subject', 'name ratingEnabled')
            .sort({ year: 1, month: 1 })
            .lean();

        const trendMonthMap = {};
        allStudentRatings
            .filter(r => r.subject && r.subject.ratingEnabled !== false)
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
            ratedSubjectCount: m.scores.length
        })).sort((a, b) => `${a.year}-${String(a.month).padStart(2, '0')}`.localeCompare(`${b.year}-${String(b.month).padStart(2, '0')}`));

        // 8. Cumulative Academic Year Average for this student
        let yearAverage = null;
        if (allStudentRatings.length > 0) {
            const validYearRatings = allStudentRatings.filter(r => r.subject && r.subject.ratingEnabled !== false);
            if (validYearRatings.length > 0) {
                yearAverage = parseFloat((validYearRatings.reduce((s, r) => s + r.averageScore, 0) / validYearRatings.length).toFixed(2));
            }
        }

        res.json({
            success: true,
            student: {
                _id: student._id,
                name: student.name,
                regNo: student.regNo,
                gender: student.gender
            },
            month,
            year,
            overallAverage,
            dataPointAverages: {
                classEngagement: avgEngagement,
                homeworkClasswork: avgHomework,
                behaviourSocial: avgBehaviour,
                englishComm: avgEnglish
            },
            subjects: subjectBreakdown,
            classBenchmark,
            yearAverage,
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

// @route   PATCH /api/student-ratings/admin/toggle-subject
// @desc    Toggle ratingEnabled for a subject across ALL classes school-wide
// @access  Private (Admin)
router.patch('/admin/toggle-subject', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        const { subjectName, ratingEnabled } = req.body;
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
});

// @route   PATCH /api/student-ratings/admin/subject/:subjectId/toggle-rating
// @desc    Toggle ratingEnabled for a subject — updates ALL classes with that subject name
// @access  Private (Admin)
router.patch('/admin/subject/:subjectId/toggle-rating', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        const { subjectId } = req.params;
        const { ratingEnabled } = req.body;

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
});

// @route   POST /api/student-ratings/admin/bulk-configure-ratings
// @desc    Bulk configure ratingEnabled school-wide (all subjects or list of subject names/ids)
// @access  Private (Admin)
router.post('/admin/bulk-configure-ratings', [auth, yearContext, requireAdmin], async (req, res) => {
    try {
        const { subjectIds, subjectNames, all, ratingEnabled } = req.body;
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
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

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
        const now = new Date();
        const isPastMonth = year < now.getFullYear() || (year === now.getFullYear() && month < (now.getMonth() + 1));

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

        // Build teacher-wise view and class-wise view
        const teacherMap = {};
        const classMap = {};

        validSubjects.forEach(subject => {
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

        const totalSubjects = validSubjects.length;
        const totalCompleted = validSubjects.filter(s => {
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
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const now = new Date();
        const isPastMonth = year < now.getFullYear() || (year === now.getFullYear() && month < (now.getMonth() + 1));

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

        const subjectStatuses = subjects.map(subject => {
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
