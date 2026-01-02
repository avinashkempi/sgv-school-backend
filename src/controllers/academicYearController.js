const AcademicYear = require('../models/AcademicYear');
const StudentHistory = require('../models/StudentHistory');
const User = require('../models/User');
const Class = require('../models/Class');
const Attendance = require('../models/Attendance');
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const LeaveRequest = require('../models/LeaveRequest');
const yearAnalytics = require('../services/yearAnalytics');
const crypto = require('crypto');

// Store rollback data temporarily (in production, use Redis or database)
const rollbackStore = new Map();

exports.createYear = async (req, res) => {
    const { name, startDate, endDate, isActive, description, terms, settings } = req.body;

    try {
        let year = await AcademicYear.findOne({ name });
        if (year) {
            return res.status(400).json({ msg: 'Academic year already exists' });
        }

        year = new AcademicYear({
            name,
            startDate,
            endDate,
            isActive,
            description,
            terms,
            settings
        });

        await year.save();
        res.json(year);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

exports.getAllYears = async (req, res) => {
    try {
        const years = await AcademicYear.find().sort({ startDate: -1 }).lean();
        res.json(years);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

/**
 * NEW: Preview transition impact
 */
exports.previewTransition = async (req, res) => {
    const { currentYearId, nextYearId } = req.body;

    try {
        const impactAnalysis = await yearAnalytics.getYearImpactAnalysis(currentYearId, nextYearId);
        res.json(impactAnalysis);
    } catch (err) {
        console.error('Preview Transition Error:', err.message);
        res.status(500).json({ message: 'Error generating transition preview', error: err.message });
    }
};

/**
 * NEW: Execute year transition
 */
exports.executeTransition = async (req, res) => {
    const { currentYearId, nextYearId, promotionPlan, createRollback = true } = req.body;

    try {
        const currentYear = await AcademicYear.findById(currentYearId);
        const nextYear = await AcademicYear.findById(nextYearId);

        if (!currentYear || !nextYear) {
            return res.status(404).json({ msg: 'Academic years not found' });
        }

        // Store current state for rollback
        let rollbackToken = null;
        if (createRollback) {
            rollbackToken = crypto.randomBytes(16).toString('hex');
            const rollbackData = await captureRollbackData(currentYearId);
            rollbackStore.set(rollbackToken, {
                data: rollbackData,
                expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
            });
        }

        // Create StudentHistory records
        const students = await User.find({
            role: 'student',
            academicYear: currentYearId
        }).populate('currentClass');

        const historyRecords = students.map(student => ({
            student: student._id,
            class: student.currentClass ? student.currentClass._id : null,
            academicYear: currentYear._id,
            result: 'Promoted',
            finalGrade: ''
        })).filter(record => record.class !== null);

        if (historyRecords.length > 0) {
            await StudentHistory.insertMany(historyRecords);
        }

        // Execute promotions based on promotion plan
        let promotedCount = 0;
        let graduatedCount = 0;

        for (const plan of promotionPlan) {
            const student = await User.findById(plan.studentId);
            if (!student) continue;

            if (plan.status === 'graduated') {
                student.currentClass = null;
                student.isActive = false; // Mark as graduated
                graduatedCount++;
            } else if (plan.nextClassId) {
                student.currentClass = plan.nextClassId;
                promotedCount++;
            }

            student.academicYear = nextYear._id;
            await student.save();
        }

        // Generate snapshot for current year before archiving
        const snapshot = await yearAnalytics.generateSnapshot(currentYearId);
        currentYear.snapshot = snapshot;
        currentYear.status = 'archived';
        currentYear.promotedTo = nextYear._id;
        await currentYear.save();

        // Activate next year
        nextYear.isActive = true;
        nextYear.status = 'current';
        nextYear.promotedFrom = currentYear._id;
        nextYear.transitionDate = new Date();
        nextYear.transitionBy = req.user.id;
        await nextYear.save();

        res.json({
            success: true,
            message: `Academic year transitioned to ${nextYear.name}`,
            summary: {
                studentsPromoted: promotedCount,
                studentsGraduated: graduatedCount,
                historicalRecordsCreated: historyRecords.length,
                snapshotCaptured: true
            },
            rollbackToken: createRollback ? rollbackToken : null,
            rollbackExpiresIn: createRollback ? '24 hours' : null
        });

    } catch (err) {
        console.error('Execute Transition Error:', err.message);
        res.status(500).json({ message: 'Error executing transition', error: err.message });
    }
};

/**
 * NEW: Rollback year transition
 */
exports.rollbackTransition = async (req, res) => {
    const { rollbackToken, confirmed } = req.body;

    if (!confirmed) {
        return res.status(400).json({ message: 'Confirmation required for rollback' });
    }

    try {
        const rollbackEntry = rollbackStore.get(rollbackToken);

        if (!rollbackEntry) {
            return res.status(404).json({ message: 'Rollback token not found or expired' });
        }

        if (Date.now() > rollbackEntry.expiresAt) {
            rollbackStore.delete(rollbackToken);
            return res.status(410).json({ message: 'Rollback window expired (24 hours)' });
        }

        // Perform rollback
        await performRollback(rollbackEntry.data);

        // Remove rollback token
        rollbackStore.delete(rollbackToken);

        res.json({
            success: true,
            message: 'Year transition rolled back successfully'
        });

    } catch (err) {
        console.error('Rollback Error:', err.message);
        res.status(500).json({ message: 'Error performing rollback', error: err.message });
    }
};

/**
 * NEW: Get dashboard data for all years
 */
exports.getDashboardData = async (req, res) => {
    try {
        const years = await AcademicYear.find().sort({ startDate: -1 }).lean();

        const currentYear = years.find(y => y.isActive);
        const upcomingYears = years.filter(y => y.status === 'draft');
        const archivedYears = years.filter(y => y.status === 'archived');

        res.json({
            currentYear,
            upcomingYears,
            archivedYears,
            totalYears: years.length,
            years
        });
    } catch (err) {
        console.error('Dashboard Error:', err.message);
        res.status(500).json({ message: 'Error fetching dashboard data', error: err.message });
    }
};

/**
 * NEW: Compare multiple years
 */
exports.compareYears = async (req, res) => {
    const { years } = req.query;

    if (!years) {
        return res.status(400).json({ message: 'Year IDs required' });
    }

    try {
        const yearIds = years.split(',');
        const comparison = await yearAnalytics.getMultiYearComparison(yearIds);
        res.json(comparison);
    } catch (err) {
        console.error('Comparison Error:', err.message);
        res.status(500).json({ message: 'Error comparing years', error: err.message });
    }
};

/**
 * NEW: Get comprehensive report for a year
 */
exports.getComprehensiveReport = async (req, res) => {
    const { yearId } = req.params;

    try {
        const year = await AcademicYear.findById(yearId);
        if (!year) {
            return res.status(404).json({ message: 'Academic year not found' });
        }

        const snapshot = year.snapshot || await yearAnalytics.generateSnapshot(yearId);

        res.json({
            year: {
                name: year.name,
                startDate: year.startDate,
                endDate: year.endDate,
                status: year.status
            },
            snapshot,
            // Additional report data can be added here
        });
    } catch (err) {
        console.error('Report Error:', err.message);
        res.status(500).json({ message: 'Error generating report', error: err.message });
    }
};

// Keep existing methods
exports.incrementYear = async (req, res) => {
    const { nextYearId } = req.body;

    try {
        const nextYear = await AcademicYear.findById(nextYearId);
        if (!nextYear) {
            return res.status(404).json({ msg: 'Next academic year not found' });
        }

        const currentYear = await AcademicYear.findOne({ isActive: true });
        if (!currentYear) {
            nextYear.isActive = true;
            await nextYear.save();
            return res.json({ msg: `Academic year activated: ${nextYear.name}` });
        }

        const students = await User.find({ role: 'student', academicYear: currentYear._id })
            .populate('currentClass');

        const historyRecords = students.map(student => ({
            student: student._id,
            class: student.currentClass ? student.currentClass._id : null,
            academicYear: currentYear._id,
            result: 'Promoted',
            finalGrade: ''
        })).filter(record => record.class !== null);

        if (historyRecords.length > 0) {
            await StudentHistory.insertMany(historyRecords);
        }

        for (const student of students) {
            if (student.currentClass) {
                const currentClassName = student.currentClass.name;
                const match = currentClassName.match(/(\d+)/);
                if (match) {
                    const currentNum = parseInt(match[0]);
                    const nextNum = currentNum + 1;
                    const nextClassNameRegex = new RegExp(`${nextNum}`);

                    const nextClass = await Class.findOne({
                        name: { $regex: nextClassNameRegex },
                        branch: student.currentClass.branch
                    });

                    if (nextClass) {
                        student.currentClass = nextClass._id;
                    } else {
                        student.currentClass = null;
                    }
                } else {
                    student.currentClass = null;
                }
            }

            student.academicYear = nextYear._id;
            await student.save();
        }

        nextYear.isActive = true;
        await nextYear.save();

        res.json({ msg: `Academic year incremented to ${nextYear.name}. Students promoted.` });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

exports.getReports = async (req, res) => {
    const { academicYearId } = req.params;

    try {
        const year = await AcademicYear.findById(academicYearId);
        if (!year) return res.status(404).json({ msg: 'Academic year not found' });

        const [history, exams, teacherLeaves, teacherAttendance] = await Promise.all([
            StudentHistory.find({ academicYear: academicYearId })
                .populate('student', 'name email phone')
                .populate('class', 'name section')
                .lean(),
            Exam.find({ academicYear: academicYearId }).lean(),
            LeaveRequest.find({
                applicantRole: { $in: ['teacher', 'class teacher', 'staff'] },
                startDate: { $gte: year.startDate, $lte: year.endDate }
            }).populate('applicant', 'name role').lean(),
            Attendance.aggregate([
                {
                    $match: {
                        role: { $in: ['teacher', 'class teacher', 'staff'] },
                        date: { $gte: year.startDate, $lte: year.endDate }
                    }
                },
                {
                    $group: {
                        _id: { user: '$user', status: '$status' },
                        count: { $sum: 1 }
                    }
                },
                {
                    $lookup: {
                        from: 'users',
                        localField: '_id.user',
                        foreignField: '_id',
                        as: 'userInfo'
                    }
                },
                {
                    $project: {
                        user: { $arrayElemAt: ['$userInfo.name', 0] },
                        status: '$_id.status',
                        count: 1
                    }
                }
            ])
        ]);

        const classWiseStudents = history.reduce((acc, curr) => {
            const className = curr.class ? `${curr.class.name} ${curr.class.section || ''}` : 'Unassigned';
            if (!acc[className]) acc[className] = [];
            acc[className].push(curr.student);
            return acc;
        }, {});

        const examIds = exams.map(e => e._id);
        const marks = await Marks.find({ exam: { $in: examIds } })
            .populate('student', 'name')
            .populate('exam', 'name subject totalMarks')
            .lean();

        res.json({
            academicYear: year,
            classWiseStudents,
            marks,
            teacherLeaves,
            teacherAttendance
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
};

// Helper functions
async function captureRollbackData(currentYearId) {
    const students = await User.find({
        role: 'student',
        academicYear: currentYearId
    }).lean();

    const currentYear = await AcademicYear.findById(currentYearId).lean();

    return {
        students,
        currentYear,
        timestamp: new Date()
    };
}

async function performRollback(rollbackData) {
    // Restore student data
    for (const student of rollbackData.students) {
        await User.findByIdAndUpdate(student._id, {
            academicYear: student.academicYear,
            currentClass: student.currentClass,
            isActive: student.isActive
        });
    }

    // Restore current year status
    await AcademicYear.findByIdAndUpdate(rollbackData.currentYear._id, {
        isActive: true,
        status: 'current'
    });

    console.log('Rollback completed successfully');
}

module.exports = exports;
