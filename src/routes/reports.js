const express = require('express');
const router = express.Router();
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const User = require('../models/User');
const AcademicYear = require('../models/AcademicYear');
const StudentHistory = require('../models/StudentHistory');
const { authenticateToken: auth, checkRole } = require('../middleware/auth');

// Helper to get grade
const getGrade = (percentage) => {
    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 70) return 'B+';
    if (percentage >= 60) return 'B';
    if (percentage >= 50) return 'C';
    if (percentage >= 40) return 'D';
    return 'F';
};

// Helper: get active academic year ID
const getActiveYearId = async (providedId) => {
    if (providedId) return providedId;
    const activeYear = await AcademicYear.findOne({ isActive: true }).lean();
    return activeYear ? activeYear._id : null;
};

// Helper: compute overall percentage for a student given exams + marks
const computeStudentOverall = (exams, marks) => {
    const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
    let grandTotalMax = 0;
    let grandTotalObtained = 0;

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

        // Only count completed exam types
        if (typeExams.length > 0 && allHaveMarks) {
            grandTotalMax += totalMax;
            grandTotalObtained += totalObtained;
        }
    });

    return grandTotalMax > 0
        ? parseFloat(((grandTotalObtained / grandTotalMax) * 100).toFixed(1))
        : 0;
};

// @route   GET /api/reports/student/:studentId
// @desc    Get standardized report card (FA1...SA2 structure) with class rank
// @access  Private (Students can only view their own)
router.get('/student/:studentId', auth, async (req, res) => {
    try {
        const { academicYearId } = req.query;
        const studentId = req.params.studentId;

        // Role-based access: students can only view their own report
        if (req.user.role === 'student' && req.user.userId !== studentId) {
            return res.status(403).json({ message: 'Not authorized to view another student\'s report' });
        }

        const student = await User.findById(studentId)
            .select('name email currentClass')
            .populate('currentClass', 'name section')
            .lean();

        if (!student) {
            return res.status(404).json({ message: 'Student not found' });
        }

        const yearId = await getActiveYearId(academicYearId);

        // Fetch all standardized exams for this class & year
        const exams = await Exam.find({
            class: student.currentClass._id,
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

            let totalMax = 0;
            let totalObtained = 0;
            const subjects = typeExams.map(exam => {
                const markEntry = marks.find(m => m.exam.toString() === exam._id.toString());
                const obtained = markEntry ? markEntry.marksObtained : 0;
                const max = exam.totalMarks;

                totalMax += max;
                if (markEntry) totalObtained += obtained;

                return {
                    subject: exam.subject.name,
                    subjectId: exam.subject._id,
                    maxMarks: max,
                    obtainedMarks: markEntry ? obtained : null,
                    percentage: markEntry ? ((obtained / max) * 100).toFixed(1) : null,
                    grade: markEntry ? getGrade((obtained / max) * 100) : '-'
                };
            });

            const percentage = totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(1) : 0;

            return {
                examType: type,
                isCompleted: typeExams.length > 0 && subjects.every(s => s.obtainedMarks !== null),
                totalMax,
                totalObtained,
                percentage,
                grade: getGrade(percentage),
                subjects
            };
        });

        // Calculate Overall Performance
        let grandTotalMax = 0;
        let grandTotalObtained = 0;
        reportData.forEach(r => {
            if (r.isCompleted) {
                grandTotalMax += r.totalMax;
                grandTotalObtained += r.totalObtained;
            }
        });

        const overallPercentage = grandTotalMax > 0 ? ((grandTotalObtained / grandTotalMax) * 100).toFixed(1) : 0;

        // --- Class Rank Calculation ---
        // Get all students in the same class
        const classmates = await User.find({
            currentClass: student.currentClass._id,
            role: 'student'
        }).select('_id').lean();

        // Get all marks for all classmates for these exams
        const allClassMarks = await Marks.find({
            student: { $in: classmates.map(s => s._id) },
            exam: { $in: exams.map(e => e._id) }
        }).lean();

        const classmatePercentages = classmates.map(cm => {
            const cmMarks = allClassMarks.filter(m => m.student.toString() === cm._id.toString());
            let cmGrandMax = 0;
            let cmGrandObtained = 0;
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

                if (typeExams.length > 0 && allHaveMarks) {
                    cmGrandMax += totalMax;
                    cmGrandObtained += totalObtained;
                    examWisePct[type] = parseFloat(((totalObtained / totalMax) * 100).toFixed(1));
                }
            });

            const pct = cmGrandMax > 0 ? parseFloat(((cmGrandObtained / cmGrandMax) * 100).toFixed(1)) : 0;
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

        res.json({
            student: {
                name: student.name,
                class: student.currentClass.name + ' ' + (student.currentClass.section || '')
            },
            exams: reportData,
            overall: {
                percentage: overallPercentage,
                grade: getGrade(overallPercentage),
                classRank,
                totalInClass
            }
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/reports/insights/:studentId
// @desc    Get performance trends
// @access  Private (Students can only view their own)
router.get('/insights/:studentId', auth, async (req, res) => {
    try {
        const { academicYearId } = req.query;
        const studentId = req.params.studentId;

        // Role-based access: students can only view their own insights
        if (req.user.role === 'student' && req.user.userId !== studentId) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const yearId = await getActiveYearId(academicYearId);

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

        exams.forEach(exam => {
            const subjectName = exam.subject.name;
            if (!subjectTrends[subjectName]) {
                subjectTrends[subjectName] = [];
            }

            const mark = marks.find(m => m.exam.toString() === exam._id.toString());
            if (mark) {
                subjectTrends[subjectName].push({
                    exam: exam.standardizedType,
                    percentage: mark.percentage
                });
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
                percentage: totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(1) : 0
            };
        });

        res.json({
            subjectTrends,
            examTrends
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/reports/class-ranking/:classId
// @desc    Get class ranking — all students ranked by overall percentage
// @access  Private (Admin/Teacher only — students cannot see other students' data)
router.get('/class-ranking/:classId', auth, async (req, res) => {
    try {
        // Only admin, super admin, and teachers can view full class rankings
        if (req.user.role === 'student') {
            return res.status(403).json({ message: 'Not authorized to view class rankings' });
        }

        const { academicYearId } = req.query;
        const yearId = await getActiveYearId(academicYearId);

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

        // Compute percentages for each student
        const rankings = students.map(student => {
            const studentMarks = allMarks.filter(m => m.student.toString() === student._id.toString());
            let grandTotalMax = 0;
            let grandTotalObtained = 0;

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

                if (typeExams.length > 0 && allHaveMarks) {
                    grandTotalMax += totalMax;
                    grandTotalObtained += totalObtained;
                }
            });

            const percentage = grandTotalMax > 0
                ? parseFloat(((grandTotalObtained / grandTotalMax) * 100).toFixed(1))
                : 0;

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
