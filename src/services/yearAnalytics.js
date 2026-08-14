const AcademicYear = require('../models/AcademicYear');
const User = require('../models/User');
const Class = require('../models/Class');
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const Attendance = require('../models/Attendance');
const Subject = require('../models/Subject');
const LeaveRequest = require('../models/LeaveRequest');

/**
 * Year Analytics Service
 * Provides comprehensive analytics and insights for academic year management
 */

/**
 * Get impact analysis for year transition
 * @param {String} currentYearId - Current academic year ID
 * @param {String} nextYearId - Next academic year ID
 * @returns {Object} Impact analysis with predictions and warnings
 */
const getYearImpactAnalysis = async (currentYearId, nextYearId) => {
    try {
        const currentYear = await AcademicYear.findById(currentYearId);
        const nextYear = await AcademicYear.findById(nextYearId);

        if (!currentYear || !nextYear) {
            throw new Error('Academic years not found');
        }

        // Get current students
        const students = await User.find({
            role: 'student',
            academicYear: currentYearId
        }).populate('currentClass');

        // Analyze promotion paths
        const promotionAnalysis = await analyzePromotions(students);

        // Get class capacity information
        const classes = await Class.find({}).lean();
        const classCapacity = await analyzeClassCapacity(classes, promotionAnalysis.promotionPlan);

        // Count data to be archived
        const dataArchival = await countArchivalData(currentYearId);

        // Generate warnings
        const warnings = await generateWarnings(classCapacity, promotionAnalysis, currentYearId);

        return {
            impact: {
                studentsAffected: students.length,
                studentsPromoted: promotionAnalysis.promotedCount,
                studentsGraduated: promotionAnalysis.graduatedCount,
                studentsNeedReview: promotionAnalysis.manualReviewCount,
                classesAffected: new Set(students.map(s => s.currentClass?._id?.toString()).filter(Boolean)).size,
                teachersAffected: await countAffectedTeachers(currentYearId)
            },
            promotionPlan: promotionAnalysis.promotionPlan,
            classCapacity,
            dataArchival,
            warnings,
            currentYear: {
                name: currentYear.name,
                totalStudents: students.length
            },
            nextYear: {
                name: nextYear.name,
                status: nextYear.status
            }
        };
    } catch (error) {
        console.error('Impact Analysis Error:', error);
        throw error;
    }
};

/**
 * Analyze student promotions
 */
async function analyzePromotions(students) {
    const promotionPlan = [];
    let promotedCount = 0;
    let graduatedCount = 0;
    let manualReviewCount = 0;

    for (const student of students) {
        const analysis = await analyzeStudentPromotion(student);
        promotionPlan.push(analysis);

        if (analysis.status === 'auto') promotedCount++;
        else if (analysis.status === 'graduated') graduatedCount++;
        else manualReviewCount++;
    }

    return {
        promotionPlan,
        promotedCount,
        graduatedCount,
        manualReviewCount
    };
}

/**
 * Analyze individual student promotion
 */
async function analyzeStudentPromotion(student) {
    if (!student.currentClass) {
        return {
            studentId: student._id,
            studentName: student.name,
            currentClass: null,
            nextClass: null,
            status: 'manual_review',
            reason: 'Not assigned to any class'
        };
    }

    const currentClassName = student.currentClass.name;
    const match = currentClassName.match(/(\d+)/);

    if (!match) {
        return {
            studentId: student._id,
            studentName: student.name,
            currentClass: currentClassName,
            nextClass: null,
            status: 'manual_review',
            reason: 'Non-numeric class name'
        };
    }

    const currentNum = parseInt(match[0]);
    const nextNum = currentNum + 1;

    // Check if this is the final class (e.g., 12th grade)
    if (currentNum >= 12) {
        return {
            studentId: student._id,
            studentName: student.name,
            currentClass: currentClassName,
            nextClass: 'GRADUATED',
            status: 'graduated',
            reason: 'Completed final year'
        };
    }

    // Find next class
    const nextClassNameRegex = new RegExp(`${nextNum}`);
    const nextClass = await Class.findOne({
        name: { $regex: nextClassNameRegex },
        branch: student.currentClass.branch
    });

    if (nextClass) {
        return {
            studentId: student._id,
            studentName: student.name,
            currentClass: currentClassName + ' ' + (student.currentClass.section || ''),
            nextClass: nextClass.name + ' ' + (nextClass.section || ''),
            nextClassId: nextClass._id,
            status: 'auto',
            reason: 'Standard promotion'
        };
    }

    return {
        studentId: student._id,
        studentName: student.name,
        currentClass: currentClassName,
        nextClass: null,
        status: 'manual_review',
        reason: 'No matching next class found'
    };
}

/**
 * Analyze class capacity
 */
async function analyzeClassCapacity(classes, promotionPlan) {
    const capacityMap = {};

    classes.forEach(cls => {
        capacityMap[cls._id.toString()] = {
            className: cls.name + ' ' + (cls.section || ''),
            capacity: cls.capacity || 50,
            current: 0,
            incoming: 0
        };
    });

    // Count incoming students
    promotionPlan.forEach(plan => {
        if (plan.nextClassId) {
            const classId = plan.nextClassId.toString();
            if (capacityMap[classId]) {
                capacityMap[classId].incoming++;
            }
        }
    });

    return Object.values(capacityMap).map(item => ({
        ...item,
        willExceed: item.incoming > item.capacity,
        available: item.capacity - item.incoming
    }));
}

/**
 * Count data to be archived
 */
async function countArchivalData(yearId) {
    const [exams, marks, attendance] = await Promise.all([
        Exam.countDocuments({ academicYear: yearId }),
        Marks.countDocuments({
            exam: {
                $in: await Exam.find({ academicYear: yearId }).select('_id')
            }
        }),
        Attendance.countDocuments({
            date: {
                $gte: (await AcademicYear.findById(yearId)).startDate,
                $lte: (await AcademicYear.findById(yearId)).endDate
            }
        })
    ]);

    return {
        examRecords: exams,
        marksEntries: marks,
        attendanceRecords: attendance
    };
}

/**
 * Count affected teachers
 */
async function countAffectedTeachers(yearId) {
    const teachers = await User.countDocuments({
        role: 'teacher',
        academicYear: yearId
    });
    return teachers;
}

/**
 * Generate warnings
 */
async function generateWarnings(classCapacity, promotionAnalysis, currentYearId) {
    const warnings = [];

    // Class capacity warnings
    classCapacity.filter(c => c.willExceed).forEach(cls => {
        warnings.push({
            type: 'capacity',
            severity: 'high',
            message: `${cls.className} will exceed capacity by ${cls.incoming - cls.capacity} students`
        });
    });

    // Manual review warnings
    if (promotionAnalysis.manualReviewCount > 0) {
        warnings.push({
            type: 'manual_review',
            severity: 'medium',
            message: `${promotionAnalysis.manualReviewCount} students require manual review`
        });
    }

    // Unfinished exams warning
    if (currentYearId) {
        const activeExamsCount = await Exam.countDocuments({
            academicYear: currentYearId,
            status: { $in: ['draft', 'scheduled', 'ongoing'] }
        });
        if (activeExamsCount > 0) {
            warnings.push({
                type: 'active_exams',
                severity: 'medium',
                message: `${activeExamsCount} exams are still active (draft, scheduled, or ongoing). Please complete or cancel them before transitioning.`
            });
        }
    }

    return warnings;
}

/**
 * Get multi-year comparison
 * @param {Array<String>} yearIds - Array of academic year IDs
 * @returns {Object} Comparative data across years
 */
const getMultiYearComparison = async (yearIds) => {
    try {
        const years = await AcademicYear.find({
            _id: { $in: yearIds }
        }).sort({ startDate: 1 }).lean();

        const comparisons = await Promise.all(
            years.map(async year => {
                const snapshot = year.snapshot || await generateSnapshot(year._id);
                return {
                    year: year.name,
                    ...snapshot
                };
            })
        );

        return {
            years: comparisons,
            trends: calculateTrends(comparisons)
        };
    } catch (error) {
        console.error('Multi-year Comparison Error:', error);
        throw error;
    }
};

/**
 * Calculate trends across years
 */
function calculateTrends(comparisons) {
    if (comparisons.length < 2) return null;

    const latest = comparisons[comparisons.length - 1];
    const previous = comparisons[comparisons.length - 2];

    return {
        studentsChange: latest.totalStudents - previous.totalStudents,
        attendanceChange: (latest.averageAttendance || 0) - (previous.averageAttendance || 0),
        examsChange: latest.totalExams - previous.totalExams
    };
}

/**
 * Generate year snapshot
 * @param {String} yearId - Academic year ID
 * @returns {Object} Statistical snapshot
 */
const generateSnapshot = async (yearId) => {
    try {
        const year = await AcademicYear.findById(yearId);

        const [
            totalStudents,
            totalClasses,
            totalExams,
            totalSubjects,
            totalTeachers,
            attendanceData
        ] = await Promise.all([
            User.countDocuments({ role: 'student', academicYear: yearId }),
            Class.countDocuments({}),
            Exam.countDocuments({ academicYear: yearId }),
            Subject.countDocuments({}),
            User.countDocuments({ role: 'teacher' }),
            Attendance.aggregate([
                {
                    $match: {
                        date: { $gte: year.startDate, $lte: year.endDate },
                        status: 'present'
                    }
                },
                {
                    $group: {
                        _id: null,
                        avgAttendance: { $avg: 1 }
                    }
                }
            ])
        ]);

        const snapshot = {
            totalStudents,
            totalClasses,
            totalExams,
            totalSubjects,
            totalTeachers,
            averageAttendance: attendanceData[0]?.avgAttendance || 0,
            capturedAt: new Date()
        };

        // Update the year with snapshot
        await AcademicYear.findByIdAndUpdate(yearId, { snapshot });

        return snapshot;
    } catch (error) {
        console.error('Snapshot Generation Error:', error);
        throw error;
    }
};

/**
 * Generate Pre-Transition Validation Report
 * @param {String} currentYearId 
 */
const generateValidationReport = async (currentYearId) => {
    try {
        const currentYear = await AcademicYear.findById(currentYearId);
        if (!currentYear) throw new Error('Academic year not found');

        const warnings = [];

        // 1. Pending Leaves Check
        const pendingLeaves = await LeaveRequest.countDocuments({
            status: 'pending',
            startDate: { $gte: currentYear.startDate, $lte: currentYear.endDate }
        });

        if (pendingLeaves > 0) {
            warnings.push({
                type: 'pending_leaves',
                severity: 'medium',
                message: `${pendingLeaves} leave requests are still pending approval/rejection.`
            });
        }

        // 2. Detained Students Check
        const detainedCount = await User.countDocuments({
            role: 'student',
            academicYear: currentYearId,
            promotionStatus: 'detained'
        });

        if (detainedCount > 0) {
            warnings.push({
                type: 'detained_students',
                severity: 'low',
                message: `${detainedCount} students are marked as 'detained' and will repeat their current class.`
            });
        }

        // 3. Missing Final (SA2) Marks Check
        const sa2Exams = await Exam.find({ academicYear: currentYearId, standardizedType: 'SA2' }).lean();
        let examsMissingMarks = 0;

        for (const exam of sa2Exams) {
            const studentCount = await User.countDocuments({ currentClass: exam.class, role: 'student', academicYear: currentYearId, promotionStatus: { $ne: 'detained' } });
            const marksCount = await Marks.countDocuments({ exam: exam._id });

            // Allow a small margin of error for absent students, but if marks are drastically lower, throw warning
            if (marksCount < studentCount && marksCount === 0) {
                // If 0 marks are entered for the whole class's SA2 exam, it's a huge red flag
                examsMissingMarks++;
            }
        }

        if (examsMissingMarks > 0) {
            warnings.push({
                type: 'missing_final_marks',
                severity: 'high',
                message: `${examsMissingMarks} 'SA2' (Final) exams have absolutely zero marks entered. Proceeding may result in blank report cards.`
            });
        }

        // 4. Unfinished Exams Check
        const activeExamsCount = await Exam.countDocuments({
            academicYear: currentYearId,
            status: { $in: ['draft', 'scheduled', 'ongoing'] }
        });

        if (activeExamsCount > 0) {
            warnings.push({
                type: 'active_exams',
                severity: 'medium',
                message: `${activeExamsCount} exams are still active (draft, scheduled, or ongoing). Please complete or cancel them before transitioning.`
            });
        }

        return warnings;
    } catch (error) {
        console.error('Validation Report Error:', error);
        throw error;
    }
};

module.exports = {
    getYearImpactAnalysis,
    getMultiYearComparison,
    generateSnapshot,
    generateValidationReport
};
