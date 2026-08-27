const express = require('express');
const router = express.Router();
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const User = require('../models/User');
const AcademicYear = require('../models/AcademicYear');
const StudentHistory = require('../models/StudentHistory');
const { authenticateToken: auth } = require('../middleware/auth');
const { requireStudentAccessParam, requireClassAccessParam } = require('../middleware/accessControl');

const Attendance = require('../models/Attendance');
const { yearContext } = require('../middleware/yearContext');

// Helper to get grade: 90-100 A+, 70-89 A, 50-69 B+, 30-49 B, Below 30 C
const getGrade = (percentage) => {
    if (percentage >= 90) return 'A+';
    if (percentage >= 70) return 'A';
    if (percentage >= 50) return 'B+';
    if (percentage >= 30) return 'B';
    return 'C';
};

// Helper: get active academic year ID
const getActiveYearId = async (providedId, reqYearContext) => {
    if (providedId) return providedId;
    if (reqYearContext) return reqYearContext;
    const activeYear = await AcademicYear.findOne({ isActive: true }).lean();
    return activeYear ? activeYear._id : null;
};

// Exam-type weights: FA1=10%, FA2=10%, SA1=30%, FA3=10%, FA4=10%, SA2=30%
const EXAM_WEIGHTS = { FA1: 10, FA2: 10, SA1: 30, FA3: 10, FA4: 10, SA2: 30 };

/**
 * Compute weighted overall percentage for a student.
 * Each completed exam type contributes: (typeObtained/typeMax)*100 * weight.
 * If only some types are done, the denominator is the sum of their weights.
 */
const computeWeightedPercentage = (completedTypeScores) => {
    // completedTypeScores: { FA1: pct, SA1: pct, ... } — only completed types
    const totalWeight = Object.keys(completedTypeScores)
        .reduce((sum, type) => sum + (EXAM_WEIGHTS[type] || 0), 0);
    if (totalWeight === 0) return 0;
    const weightedSum = Object.entries(completedTypeScores)
        .reduce((sum, [type, pct]) => sum + pct * (EXAM_WEIGHTS[type] || 0), 0);
    return parseFloat((weightedSum / totalWeight).toFixed(1));
};

// Helper: compute overall percentage for a student given exams + marks
const computeStudentOverall = (exams, marks) => {
    const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
    const completedTypeScores = {};

    examTypes.forEach(type => {
        const typeExams = exams.filter(e => e.standardizedType === type);
        let totalMax = 0;
        let totalObtained = 0;
        let allHaveMarks = true;

        typeExams.forEach(exam => {
            const markEntry = marks.find(m =>
                m.exam.toString() === exam._id.toString() &&
                m.student.toString() === (marks._studentId || m.student).toString()
            );
            if (markEntry) {
                totalMax += exam.totalMarks;
                totalObtained += markEntry.marksObtained;
            } else {
                allHaveMarks = false;
            }
        });

        if (typeExams.length > 0 && allHaveMarks && totalMax > 0) {
            completedTypeScores[type] = (totalObtained / totalMax) * 100;
        }
    });

    return computeWeightedPercentage(completedTypeScores);
};

// @route   GET /api/reports/student/:studentId
// @desc    Get standardized report card (FA1...SA2 structure) with class rank & comprehensive metrics
// @access  Private (Students can only view their own)
router.get('/student/:studentId', [auth, yearContext, requireStudentAccessParam('studentId')], async (req, res) => {
    try {
        const { academicYearId } = req.query;
        const studentId = req.params.studentId;

        // Role-based access: students can only view their own report
        if (req.user.role === 'student' && req.user.userId !== studentId) {
            return res.status(403).json({ message: 'Not authorized to view another student\'s report' });
        }

        const student = await User.findById(studentId)
            .select('name email rollNumber admissionNumber profileImage currentClass')
            .populate('currentClass', 'name section')
            .lean();

        if (!student) {
            return res.status(404).json({ message: 'Student not found' });
        }

        const yearId = await getActiveYearId(academicYearId, req.academicYearContext);
        const activeYear = yearId
            ? await AcademicYear.findById(yearId).select('name code startDate endDate').lean()
            : await AcademicYear.findOne({ isActive: true }).select('name code startDate endDate').lean();

        // Fetch attendance stats for this student in the target academic year
        let attendanceSummary = { percentage: 0, presentDays: 0, totalDays: 0 };
        if (yearId) {
            const attQuery = { user: studentId };
            if (activeYear?.startDate) {
                attQuery.date = { $gte: activeYear.startDate };
                if (activeYear.endDate) {
                    attQuery.date.$lte = activeYear.endDate;
                }
            }
            const attRecords = await Attendance.find(attQuery).select('status').lean();
            const totalDays = attRecords.length;
            const presentDays = attRecords.filter(a => ['present', 'late', 'excused'].includes(a.status)).length;
            attendanceSummary = {
                percentage: totalDays > 0 ? parseFloat(((presentDays / totalDays) * 100).toFixed(1)) : 0,
                presentDays,
                totalDays
            };
        }

        // Fetch all standardized exams for this class & year
        const exams = await Exam.find({
            class: student.currentClass?._id,
            academicYear: yearId,
            isStandardized: true
        }).populate('subject', 'name').lean();

        // Fetch all marks for this student
        const marks = await Marks.find({
            student: studentId,
            exam: { $in: exams.map(e => e._id) }
        }).lean();

        // Structure data by Exam Type (FA1, FA2...)
        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const reportData = examTypes.map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);

            let status = 'not_initialized';
            if (typeExams.length > 0) {
                status = 'pending';
            }

            let totalMax = 0;      // max of subjects that HAVE marks
            let totalObtained = 0; // obtained of subjects that HAVE marks

            const subjects = typeExams.map(exam => {
                const markEntry = marks.find(m => m.exam.toString() === exam._id.toString());
                const max = exam.totalMarks;

                if (markEntry) {
                    const obtained = markEntry.marksObtained;
                    totalMax += max;
                    totalObtained += obtained;
                    const subPct = (obtained / max) * 100;
                    return {
                        subject: exam.subject.name,
                        subjectId: exam.subject._id,
                        maxMarks: max,
                        obtainedMarks: obtained,
                        percentage: parseFloat(subPct.toFixed(1)),
                        grade: getGrade(subPct),
                        remarks: markEntry.remarks || null
                    };
                }

                // Marks not yet entered for this subject
                return {
                    subject: exam.subject.name,
                    subjectId: exam.subject._id,
                    maxMarks: max,
                    obtainedMarks: null,
                    percentage: null,
                    grade: '-',
                    remarks: null
                };
            });

            const allMarksEntered = typeExams.length > 0 && subjects.every(s => s.obtainedMarks !== null);
            if (allMarksEntered) status = 'completed';

            const percentage = totalMax > 0 ? parseFloat(((totalObtained / totalMax) * 100).toFixed(1)) : null;

            // Highlight top & lowest subjects for this exam
            const gradedSubjects = subjects.filter(s => s.percentage !== null);
            let topSubject = null;
            let lowestSubject = null;
            if (gradedSubjects.length > 0) {
                const sorted = [...gradedSubjects].sort((a, b) => b.percentage - a.percentage);
                topSubject = sorted[0];
                if (sorted.length > 1) {
                    lowestSubject = sorted[sorted.length - 1];
                }
            }

            return {
                examType: type,
                weightage: EXAM_WEIGHTS[type] || 0,
                status,                         // 'not_initialized' | 'pending' | 'completed'
                isCompleted: status === 'completed',
                totalMax,
                totalObtained,
                percentage,
                grade: percentage !== null ? getGrade(percentage) : '-',
                subjects,
                topSubject: topSubject ? { name: topSubject.subject, percentage: topSubject.percentage } : null,
                lowestSubject: lowestSubject ? { name: lowestSubject.subject, percentage: lowestSubject.percentage } : null
            };
        });

        // Calculate Overall Performance using weighted percentages
        const completedTypeScores = {};
        reportData.forEach(r => {
            if (r.isCompleted && r.totalMax > 0) {
                completedTypeScores[r.examType] = (r.totalObtained / r.totalMax) * 100;
            }
        });

        const overallPercentage = computeWeightedPercentage(completedTypeScores);

        // --- Class Rank & Benchmark Calculation ---
        const classmates = student.currentClass?._id ? await User.find({
            currentClass: student.currentClass._id,
            role: 'student'
        }).select('_id').lean() : [];

        const allClassMarks = await Marks.find({
            student: { $in: classmates.map(s => s._id) },
            exam: { $in: exams.map(e => e._id) }
        }).lean();

        const classmatePercentages = classmates.map(cm => {
            const cmMarks = allClassMarks.filter(m => m.student.toString() === cm._id.toString());
            const cmCompletedTypeScores = {};
            const examWisePct = {};

            examTypes.forEach(type => {
                const typeExams = exams.filter(e => e.standardizedType === type);
                let totalMax = 0;
                let totalObtained = 0;
                let allHaveMarks = true;

                typeExams.forEach(exam => {
                    const markEntry = cmMarks.find(m => m.exam.toString() === exam._id.toString());
                    if (markEntry) {
                        totalMax += exam.totalMarks;
                        totalObtained += markEntry.marksObtained;
                    } else {
                        allHaveMarks = false;
                    }
                });

                if (typeExams.length > 0 && allHaveMarks && totalMax > 0) {
                    const typePct = parseFloat(((totalObtained / totalMax) * 100).toFixed(1));
                    cmCompletedTypeScores[type] = typePct;
                    examWisePct[type] = typePct;
                }
            });

            const pct = computeWeightedPercentage(cmCompletedTypeScores);
            return { studentId: cm._id.toString(), percentage: pct, examWisePct };
        });

        // Sort descending and find rank
        classmatePercentages.sort((a, b) => b.percentage - a.percentage);
        const myPct = classmatePercentages.find(c => c.studentId === studentId)?.percentage;
        const classRank = myPct !== undefined ? classmatePercentages.findIndex(c => c.percentage === myPct) + 1 : 0;
        const totalInClass = classmatePercentages.length;

        // Formulate individual exam ranks
        reportData.forEach(r => {
            if (r.isCompleted) {
                const type = r.examType;
                const validPcts = classmatePercentages
                    .filter(c => c.examWisePct[type] !== undefined)
                    .map(c => ({ studentId: c.studentId, pct: c.examWisePct[type] }));
                
                validPcts.sort((a, b) => b.pct - a.pct);
                
                const myExamPct = validPcts.find(c => c.studentId === studentId)?.pct;
                if (myExamPct !== undefined) {
                    const examRankIndex = validPcts.findIndex(c => c.pct === myExamPct);
                    r.classRank = examRankIndex !== -1 ? examRankIndex + 1 : null;
                    r.totalInClassForExam = validPcts.length;
                }
            }
        });

        // Class benchmark metrics
        const completedClassmatePcts = classmatePercentages.map(c => c.percentage).filter(p => p > 0);
        const classAverage = completedClassmatePcts.length > 0
            ? parseFloat((completedClassmatePcts.reduce((a, b) => a + b, 0) / completedClassmatePcts.length).toFixed(1))
            : 0;
        const highestPercentage = completedClassmatePcts.length > 0 ? Math.max(...completedClassmatePcts) : 0;
        const lowestPercentage = completedClassmatePcts.length > 0 ? Math.min(...completedClassmatePcts) : 0;

        const totalMarksScored = reportData.reduce((acc, curr) => acc + (curr.totalObtained || 0), 0);
        const totalMaxMarks = reportData.reduce((acc, curr) => acc + (curr.totalMax || 0), 0);

        res.json({
            student: {
                id: student._id,
                name: student.name,
                email: student.email,
                rollNumber: student.rollNumber || null,
                admissionNumber: student.admissionNumber || null,
                profileImage: student.profileImage || null,
                class: student.currentClass ? `${student.currentClass.name} ${student.currentClass.section || ''}`.trim() : 'N/A',
                className: student.currentClass?.name || '',
                section: student.currentClass?.section || '',
                academicYear: activeYear?.name || ''
            },
            attendance: attendanceSummary,
            exams: reportData,
            overall: {
                percentage: overallPercentage,
                grade: getGrade(overallPercentage),
                classRank,
                totalInClass,
                totalMarksScored,
                totalMaxMarks
            },
            classStatistics: {
                classAverage,
                highestPercentage,
                lowestPercentage
            }
        });

    } catch (err) {
        console.error("Student Report Error:", err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/reports/insights/:studentId
// @desc    Get performance trends, subject analysis, and smart diagnostic insights
// @access  Private (Students can only view their own)
router.get('/insights/:studentId', [auth, yearContext, requireStudentAccessParam('studentId')], async (req, res) => {
    try {
        const { academicYearId } = req.query;
        const studentId = req.params.studentId;

        // Role-based access: students can only view their own insights
        if (req.user.role === 'student' && req.user.userId !== studentId) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const yearId = await getActiveYearId(academicYearId, req.academicYearContext);

        const student = await User.findById(studentId).lean();
        if (!student || !student.currentClass) {
            return res.status(404).json({ message: 'Student or class not found' });
        }

        const exams = await Exam.find({
            class: student.currentClass,
            academicYear: yearId,
            isStandardized: true
        }).populate('subject', 'name').sort({ date: 1 }).lean();

        const marks = await Marks.find({
            student: studentId,
            exam: { $in: exams.map(e => e._id) }
        }).lean();

        // Group by Subject
        const subjectTrends = {};
        const subjectScores = {};

        exams.forEach(exam => {
            const subjectName = exam.subject?.name || 'General';
            if (!subjectTrends[subjectName]) {
                subjectTrends[subjectName] = [];
                subjectScores[subjectName] = [];
            }

            const mark = marks.find(m => m.exam.toString() === exam._id.toString());
            if (mark) {
                const pct = mark.percentage || (exam.totalMarks > 0 ? (mark.marksObtained / exam.totalMarks) * 100 : 0);
                subjectTrends[subjectName].push({
                    exam: exam.standardizedType,
                    percentage: parseFloat(pct.toFixed(1))
                });
                subjectScores[subjectName].push(pct);
            }
        });

        // Exam-wise comparison (FA1 vs FA2 etc)
        const examTrends = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'].map(type => {
            const typeExams = exams.filter(e => e.standardizedType === type);
            let totalMax = 0;
            let totalObtained = 0;

            typeExams.forEach(exam => {
                const mark = marks.find(m => m.exam.toString() === exam._id.toString());
                if (mark) {
                    totalMax += exam.totalMarks;
                    totalObtained += mark.marksObtained;
                }
            });

            return {
                exam: type,
                percentage: totalMax > 0 ? parseFloat(((totalObtained / totalMax) * 100).toFixed(1)) : 0
            };
        });

        // Calculate Subject Averages & Strengths / Weaknesses
        const subjectSummary = Object.keys(subjectScores).map(sub => {
            const scores = subjectScores[sub];
            const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
            return {
                subject: sub,
                average: parseFloat(avg.toFixed(1)),
                grade: getGrade(avg),
                examCount: scores.length
            };
        }).filter(s => s.examCount > 0);

        subjectSummary.sort((a, b) => b.average - a.average);

        const strengths = subjectSummary.slice(0, Math.min(3, subjectSummary.length));
        const weaknesses = subjectSummary.length > 3 ? subjectSummary.slice(-2).reverse() : [];

        // Calculate Consistency Index (Standard Deviation of exam scores)
        const validExamPcts = examTrends.filter(e => e.percentage > 0).map(e => e.percentage);
        let consistencyScore = 100;
        let consistencyLabel = 'High Consistency';
        if (validExamPcts.length >= 2) {
            const mean = validExamPcts.reduce((a, b) => a + b, 0) / validExamPcts.length;
            const variance = validExamPcts.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / validExamPcts.length;
            const stdDev = Math.sqrt(variance);
            consistencyScore = Math.max(0, Math.round(100 - (stdDev * 3)));
            if (consistencyScore >= 85) consistencyLabel = 'Very Stable & Consistent';
            else if (consistencyScore >= 70) consistencyLabel = 'Moderate Fluctuations';
            else consistencyLabel = 'High Variance';
        }

        res.json({
            subjectTrends,
            examTrends,
            subjectSummary,
            strengths,
            weaknesses,
            consistency: {
                score: consistencyScore,
                label: consistencyLabel
            }
        });

    } catch (err) {
        console.error("Insights Error:", err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/reports/class-ranking/:classId
// @desc    Get class ranking — all students ranked by overall percentage
// @access  Private (Admin/Teacher only — students cannot see other students' data)
router.get('/class-ranking/:classId', [auth, yearContext, requireClassAccessParam('classId')], async (req, res) => {
    try {
        // Only admin, super admin, and teachers can view full class rankings
        if (req.user.role === 'student') {
            return res.status(403).json({ message: 'Not authorized to view class rankings' });
        }

        const { academicYearId } = req.query;
        const yearId = await getActiveYearId(academicYearId, req.academicYearContext);

        // Get all students in the class
        const students = await User.find({
            currentClass: req.params.classId,
            role: 'student'
        }).select('name email rollNumber').lean();

        if (students.length === 0) {
            return res.json({ rankings: [], totalStudents: 0 });
        }

        // Fetch all standardized exams for this class & year
        const exams = await Exam.find({
            class: req.params.classId,
            academicYear: yearId,
            isStandardized: true
        }).populate('subject', 'name').lean();

        // Get all marks for all students
        const allMarks = await Marks.find({
            student: { $in: students.map(s => s._id) },
            exam: { $in: exams.map(e => e._id) }
        }).lean();

        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];

        // Compute weighted percentages for each student
        const rankings = students.map(student => {
            const studentMarks = allMarks.filter(m => m.student.toString() === student._id.toString());
            const completedTypeScores = {};
            let grandTotalObtained = 0;
            let grandTotalMax = 0;

            examTypes.forEach(type => {
                const typeExams = exams.filter(e => e.standardizedType === type);
                let totalMax = 0;
                let totalObtained = 0;
                let allHaveMarks = true;

                typeExams.forEach(exam => {
                    const markEntry = studentMarks.find(m => m.exam.toString() === exam._id.toString());
                    if (markEntry) {
                        totalMax += exam.totalMarks;
                        totalObtained += markEntry.marksObtained;
                    } else {
                        allHaveMarks = false;
                    }
                });

                if (typeExams.length > 0 && allHaveMarks && totalMax > 0) {
                    completedTypeScores[type] = (totalObtained / totalMax) * 100;
                    grandTotalObtained += totalObtained;
                    grandTotalMax += totalMax;
                }
            });

            const percentage = computeWeightedPercentage(completedTypeScores);

            return {
                studentId: student._id,
                name: student.name,
                rollNumber: student.rollNumber,
                percentage,
                grade: getGrade(percentage),
                totalObtained: grandTotalObtained,
                totalMax: grandTotalMax
            };
        });

        // Sort by percentage descending
        rankings.sort((a, b) => b.percentage - a.percentage);

        // Assign ranks (handle ties)
        rankings.forEach((r, i) => {
            if (i > 0 && r.percentage === rankings[i - 1].percentage) {
                r.rank = rankings[i - 1].rank; // Same rank for ties
            } else {
                r.rank = i + 1;
            }
        });

        res.json({
            rankings,
            totalStudents: students.length
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/reports/history/me
// @desc    Get all historical academic report summaries for the logged-in student
// @access  Private (Student)
router.get('/history/me', auth, async (req, res) => {
    try {
        const studentId = req.user.userId;

        if (req.user.role !== 'student') {
            return res.status(403).json({ message: 'Only students can view their academic history directly' });
        }

        // 1. Fetch Immutable Student Histories
        const historyRecords = await StudentHistory.find({ student: studentId })
            .populate('academicYear', 'name startDate endDate')
            .populate('class', 'name section branch label')
            .sort({ 'academicYear.startDate': -1 })
            .lean();

        // 2. We want to attach actual exam data (if available) for those past years
        // We look for SA2 (Final) or overall totals from those historic years
        const enrichedHistory = await Promise.all(historyRecords.map(async (record) => {
            if (!record.academicYear) return record;

            const yearId = record.academicYear._id;
            const classId = record.class?._id;

            // Only trace if we have both IDs conceptually mapped
            if (!classId) return record;

            // Fetch standardized exams for that specific historical class & year combo
            const exams = await Exam.find({
                class: classId,
                academicYear: yearId,
                isStandardized: true
            }).populate('subject', 'name').lean();

            if (exams.length === 0) {
                return {
                    ...record,
                    examsAvailable: false,
                    overallPercentage: record.totalAttendancePercentage || null
                };
            }

            const marks = await Marks.find({
                student: studentId,
                exam: { $in: exams.map(e => e._id) }
            }).lean();

            const overallPercentage = computeStudentOverall(exams, marks);

            return {
                ...record,
                examsAvailable: true,
                overallPercentage,
                grade: getGrade(overallPercentage),
            };
        }));

        res.json({
            history: enrichedHistory
        });

    } catch (err) {
        console.error("Error fetching student history:", err.message);
        res.status(500).send('Server Error fetching historical reports');
    }
});

module.exports = router;
