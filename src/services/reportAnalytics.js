/**
 * Report Analytics Service
 * Centralized service for generating comprehensive exam and marks analytics
 */

const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const User = require('../models/User');

/**
 * Calculate class performance aggregation
 * @param {String} classId - Class ID
 * @param {String} academicYearId - Academic Year ID
 * @param {String} examType - Optional exam type filter
 * @returns {Object} Aggregated class performance data
 */
const getClassPerformance = async (classId, academicYearId, examType = null) => {
    try {
        // Build exam query
        let examQuery = {
            class: classId,
            academicYear: academicYearId,
            isStandardized: true
        };

        if (examType) {
            examQuery.standardizedType = examType;
        }

        // Get exams
        const exams = await Exam.find(examQuery).populate('subject', 'name').lean();

        // Get students
        const students = await User.find({
            currentClass: classId,
            role: 'student'
        }).select('name email').lean();

        // Get marks
        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({ exam: { $in: examIds } }).lean();

        // Calculate overall stats
        let totalObtained = 0;
        let totalMax = 0;

        allMarks.forEach(mark => {
            const exam = exams.find(e => e._id.toString() === mark.exam.toString());
            if (exam) {
                totalObtained += mark.marksObtained;
                totalMax += exam.totalMarks;
            }
        });

        const avgPercentage = totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(2) : 0;

        return {
            classId,
            totalStudents: students.length,
            totalExams: exams.length,
            totalMarksEntered: allMarks.length,
            averagePercentage: parseFloat(avgPercentage),
            exams,
            students,
            marks: allMarks
        };
    } catch (error) {
        console.error('Error in getClassPerformance:', error);
        throw error;
    }
};

/**
 * Get subject-wise analysis for a class
 * @param {String} classId - Class ID
 * @param {String} academicYearId - Academic Year ID
 * @returns {Object} Subject-wise performance breakdown
 */
const getSubjectWiseAnalysis = async (classId, academicYearId) => {
    try {
        const exams = await Exam.find({
            class: classId,
            academicYear: academicYearId,
            isStandardized: true
        }).populate('subject', 'name').lean();

        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({ exam: { $in: examIds } }).lean();

        // Group by subject
        const subjectMap = {};

        exams.forEach(exam => {
            const subjectId = exam.subject._id.toString();
            const subjectName = exam.subject.name;

            if (!subjectMap[subjectId]) {
                subjectMap[subjectId] = {
                    subjectId,
                    subjectName,
                    exams: [],
                    totalObtained: 0,
                    totalMax: 0,
                    marksCount: 0
                };
            }

            subjectMap[subjectId].exams.push(exam);
        });

        // Add marks data
        allMarks.forEach(mark => {
            const exam = exams.find(e => e._id.toString() === mark.exam.toString());
            if (exam && exam.subject) {
                const subjectId = exam.subject._id.toString();
                if (subjectMap[subjectId]) {
                    subjectMap[subjectId].totalObtained += mark.marksObtained;
                    subjectMap[subjectId].totalMax += exam.totalMarks;
                    subjectMap[subjectId].marksCount++;
                }
            }
        });

        // Calculate percentages
        const subjectAnalysis = Object.values(subjectMap).map(subject => {
            const percentage = subject.totalMax > 0
                ? ((subject.totalObtained / subject.totalMax) * 100).toFixed(2)
                : 0;

            return {
                subjectId: subject.subjectId,
                subjectName: subject.subjectName,
                examsCount: subject.exams.length,
                marksEntered: subject.marksCount,
                averagePercentage: parseFloat(percentage)
            };
        });

        return subjectAnalysis;
    } catch (error) {
        console.error('Error in getSubjectWiseAnalysis:', error);
        throw error;
    }
};

/**
 * Calculate student rankings for a class
 * @param {String} classId - Class ID
 * @param {String} academicYearId - Academic Year ID
 * @param {String} examType - Optional exam type filter
 * @returns {Array} Student rankings with percentages
 */
const getStudentRankings = async (classId, academicYearId, examType = null) => {
    try {
        // Build exam query
        let examQuery = {
            class: classId,
            academicYear: academicYearId,
            isStandardized: true
        };

        if (examType) {
            examQuery.standardizedType = examType;
        }

        const exams = await Exam.find(examQuery).lean();
        const students = await User.find({
            currentClass: classId,
            role: 'student'
        }).select('name email').lean();

        const examIds = exams.map(e => e._id);
        const allMarks = await Marks.find({ exam: { $in: examIds } }).lean();

        // Calculate each student's performance
        const studentPerformance = students.map(student => {
            const studentMarks = allMarks.filter(
                m => m.student.toString() === student._id.toString()
            );

            let totalObtained = 0;
            let totalMax = 0;

            studentMarks.forEach(mark => {
                const exam = exams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalObtained += mark.marksObtained;
                    totalMax += exam.totalMarks;
                }
            });

            const percentage = totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(2) : 0;

            return {
                studentId: student._id,
                studentName: student.name,
                email: student.email,
                totalObtained,
                totalMax,
                percentage: parseFloat(percentage),
                grade: getDefaultGrade(parseFloat(percentage)),
                examsAttempted: studentMarks.length,
                totalExams: exams.length
            };
        });

        // Sort by percentage descending
        studentPerformance.sort((a, b) => b.percentage - a.percentage);

        // Add ranks (handle ties)
        let currentRank = 1;
        studentPerformance.forEach((student, index) => {
            if (index > 0 && student.percentage < studentPerformance[index - 1].percentage) {
                currentRank = index + 1;
            }
            student.rank = currentRank;
            student.percentile = students.length > 0
                ? (((students.length - currentRank + 1) / students.length) * 100).toFixed(2)
                : 0;
        });

        return studentPerformance;
    } catch (error) {
        console.error('Error in getStudentRankings:', error);
        throw error;
    }
};

/**
 * Calculate grade distribution for a class
 * @param {String} classId - Class ID
 * @param {String} academicYearId - Academic Year ID
 * @param {String} examType - Optional exam type filter
 * @returns {Object} Grade distribution counts and percentages
 */
const getGradeDistribution = async (classId, academicYearId, examType = null) => {
    try {
        const rankings = await getStudentRankings(classId, academicYearId, examType);

        const distribution = {
            'A+': 0,
            'A': 0,
            'B+': 0,
            'B': 0,
            'C': 0
        };

        rankings.forEach(student => {
            if (distribution[student.grade] !== undefined) {
                distribution[student.grade]++;
            }
        });

        // Calculate percentages
        const total = rankings.length;
        const distributionWithPercentages = Object.keys(distribution).map(grade => ({
            grade,
            count: distribution[grade],
            percentage: total > 0 ? ((distribution[grade] / total) * 100).toFixed(2) : 0
        }));

        return {
            distribution,
            distributionWithPercentages,
            totalStudents: total
        };
    } catch (error) {
        console.error('Error in getGradeDistribution:', error);
        throw error;
    }
};

/**
 * Analyze performance trends across exam types
 * @param {String} classId - Class ID
 * @param {String} academicYearId - Academic Year ID
 * @returns {Object} Trend analysis across exam types
 */
const getPerformanceTrends = async (classId, academicYearId) => {
    try {
        const examTypes = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const trends = [];

        for (const type of examTypes) {
            const exams = await Exam.find({
                class: classId,
                academicYear: academicYearId,
                standardizedType: type,
                isStandardized: true
            }).lean();

            if (exams.length === 0) {
                trends.push({
                    examType: type,
                    averagePercentage: null,
                    examsCount: 0,
                    status: 'not_conducted'
                });
                continue;
            }

            const examIds = exams.map(e => e._id);
            const marks = await Marks.find({ exam: { $in: examIds } }).lean();

            let totalObtained = 0;
            let totalMax = 0;

            marks.forEach(mark => {
                const exam = exams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalObtained += mark.marksObtained;
                    totalMax += exam.totalMarks;
                }
            });

            const avgPercentage = totalMax > 0 ? ((totalObtained / totalMax) * 100).toFixed(2) : 0;

            trends.push({
                examType: type,
                averagePercentage: parseFloat(avgPercentage),
                examsCount: exams.length,
                marksEntered: marks.length,
                status: marks.length > 0 ? 'completed' : 'pending'
            });
        }

        // Calculate improvement/decline
        for (let i = 1; i < trends.length; i++) {
            if (trends[i].averagePercentage !== null && trends[i - 1].averagePercentage !== null) {
                const change = trends[i].averagePercentage - trends[i - 1].averagePercentage;
                trends[i].changeFromPrevious = parseFloat(change.toFixed(2));
                trends[i].trend = change > 0 ? 'improving' : change < 0 ? 'declining' : 'stable';
            }
        }

        return trends;
    } catch (error) {
        console.error('Error in getPerformanceTrends:', error);
        throw error;
    }
};

// Helper function to calculate default grade: 90-100 A+, 70-89 A, 50-69 B+, 30-49 B, Below 30 C
function getDefaultGrade(percentage) {
    if (percentage >= 90) return 'A+';
    if (percentage >= 70) return 'A';
    if (percentage >= 50) return 'B+';
    if (percentage >= 30) return 'B';
    return 'C';
}

/**
 * Get comprehensive class report
 * @param {String} classId - Class ID
 * @param {String} academicYearId - Academic Year ID
 * @param {String} examType - Optional exam type filter
 * @returns {Object} Complete class report with all analytics
 */
const getComprehensiveClassReport = async (classId, academicYearId, examType = null) => {
    try {
        const [
            performance,
            subjectWise,
            rankings,
            gradeDistribution,
            trends
        ] = await Promise.all([
            getClassPerformance(classId, academicYearId, examType),
            getSubjectWiseAnalysis(classId, academicYearId),
            getStudentRankings(classId, academicYearId, examType),
            getGradeDistribution(classId, academicYearId, examType),
            examType ? null : getPerformanceTrends(classId, academicYearId)
        ]);

        return {
            classId,
            academicYearId,
            examType,
            generatedAt: new Date(),
            overview: {
                totalStudents: performance.totalStudents,
                totalExams: performance.totalExams,
                averagePercentage: performance.averagePercentage,
                highest: rankings.length > 0 ? rankings[0].percentage : 0,
                lowest: rankings.length > 0 ? rankings[rankings.length - 1].percentage : 0,
                passed: rankings.filter(r => r.percentage >= 40).length,
                failed: rankings.filter(r => r.percentage < 40).length
            },
            subjectWise,
            rankings,
            gradeDistribution,
            trends
        };
    } catch (error) {
        console.error('Error in getComprehensiveClassReport:', error);
        throw error;
    }
};

module.exports = {
    getClassPerformance,
    getSubjectWiseAnalysis,
    getStudentRankings,
    getGradeDistribution,
    getPerformanceTrends,
    getComprehensiveClassReport
};
