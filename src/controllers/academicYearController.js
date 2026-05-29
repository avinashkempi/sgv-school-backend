const AcademicYear = require('../models/AcademicYear');
const StudentHistory = require('../models/StudentHistory');
const User = require('../models/User');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const Attendance = require('../models/Attendance');
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const LeaveRequest = require('../models/LeaveRequest');
const yearAnalytics = require('../services/yearAnalytics');
const crypto = require('crypto');

// Store rollback data temporarily (in production, use Redis or database)
const rollbackStore = new Map();

exports.createYear = async (req, res) => {
    const { name, startDate, endDate, description, terms, settings } = req.body;

    try {
        let year = await AcademicYear.findOne({ name });
        if (year) {
            return res.status(400).json({ msg: 'Academic year already exists' });
        }

        year = new AcademicYear({
            name,
            startDate,
            endDate,
            isActive: false, // Always create as inactive; use activate endpoint to set active
            description,
            terms,
            settings
        });

        await year.save();
        res.json(year);
    } catch (err) {
        console.error(err.message);
        if (err.name === 'ValidationError') {
            return res.status(400).json({ message: err.message, error: err.errors });
        }
        res.status(500).send('Server Error');
    }
};

// Activate a year as the current year (no transition, just set as active)
exports.activateYear = async (req, res) => {
    try {
        const { yearId } = req.params;

        const year = await AcademicYear.findById(yearId);
        if (!year) {
            return res.status(404).json({ success: false, message: 'Academic year not found' });
        }

        if (year.isActive && year.status === 'current') {
            return res.status(400).json({ success: false, message: 'This year is already active' });
        }

        // Find the previously active year BEFORE deactivating
        const previousYear = await AcademicYear.findOne({ isActive: true, _id: { $ne: year._id } });
        const previousYearId = previousYear ? previousYear._id : null;

        // Deactivate any currently active year
        await AcademicYear.updateMany(
            { isActive: true, _id: { $ne: year._id } },
            { $set: { isActive: false, status: 'archived' } }
        );

        // Activate the target year
        year.isActive = true;
        year.status = 'current';
        await year.save();

        // Move all active students into the new academic year
        const studentResult = await User.updateMany(
            { role: 'student', isActive: { $ne: false } },
            { $set: { academicYear: year._id } }
        );

        // Re-link classes that have no year, or that belonged to the previous active year
        const classFilter = previousYearId
            ? { $or: [{ academicYear: previousYearId }, { academicYear: { $exists: false } }] }
            : { academicYear: { $exists: false } };
        const classResult = await Class.updateMany(
            classFilter,
            { $set: { academicYear: year._id } }
        );

        console.log(`[ACTIVATE] Year: ${year.name} | Students moved: ${studentResult.modifiedCount} | Classes linked: ${classResult.modifiedCount}`);

        res.json({
            success: true,
            message: `${year.name} is now active. ${studentResult.modifiedCount} students updated.`,
            year,
            studentsUpdated: studentResult.modifiedCount
        });
    } catch (err) {
        console.error('Activate Year Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error' });
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
 * Validate Transition (Pre-Flight Checks)
 */
exports.validateTransition = async (req, res) => {
    try {
        const warnings = await yearAnalytics.generateValidationReport(req.params.yearId);
        res.json({ warnings });
    } catch (err) {
        console.error('Validate Transition Error:', err.message);
        res.status(500).json({ message: 'Error generating validation report', error: err.message });
    }
};

// @route   POST /api/academic-years/transition
// @desc    Execute year transition (Cloning & Promotion)
// @access  Private (Super Admin)
exports.executeTransition = async (req, res) => {
    const { currentYearId, nextYearId, promotionPlan, createRollback = true } = req.body;

    try {
        const currentYear = await AcademicYear.findById(currentYearId);
        const nextYear = await AcademicYear.findById(nextYearId);

        if (!currentYear || !nextYear) {
            return res.status(404).json({ msg: 'Academic years not found' });
        }

        let rollbackToken = null;
        if (createRollback) {
            const rollbackData = await captureRollbackData(currentYearId, nextYearId);
            rollbackToken = crypto.randomBytes(20).toString('hex');
            rollbackStore.set(rollbackToken, {
                data: rollbackData,
                expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
            });
            console.log(`[TRANSITION] Rollback token generated: ${rollbackToken}`);
        }

        // --- ASYNC NON-BLOCKING RESPONSE START ---
        // Instead of keeping the connection open for 60 seconds copying DB collections,
        // we'll respond immediately and do the heavy lifting in the background.
        res.json({
            success: true,
            message: `Transition process started in the background. Generating ${nextYear.name}...`,
            status: 'processing',
            rollbackToken: rollbackToken
        });

        // The following code runs asynchronously
        (async () => {
            try {
                console.log(`[TRANSITION] Starting transition to ${nextYear.name}`);

                // 0. EXAMS & MARKS CLEANUP FOR THE TARGET YEAR
                const nextYearExams = await Exam.find({ academicYear: nextYearId }).select('_id');
                const nextYearExamIds = nextYearExams.map(e => e._id);
                if (nextYearExamIds.length > 0) {
                    const deletedMarks = await Marks.deleteMany({ exam: { $in: nextYearExamIds } });
                    const deletedExams = await Exam.deleteMany({ _id: { $in: nextYearExamIds } });
                    console.log(`[TRANSITION] Cleared ${(deletedExams && deletedExams.deletedCount) || 0} existing exams and ${(deletedMarks && deletedMarks.deletedCount) || 0} marks from target year ${nextYear.name}.`);
                }

                // 1. CLASS DEPENDENCY RESOLUTION & CLONING
                const oldClasses = await Class.find({ academicYear: currentYearId }).lean();
                const newClassesExist = await Class.find({ academicYear: nextYearId }).lean();

                // Map old Class IDs to new Class IDs 
                // e.g., { 'old_lkg_id': 'new_lkg_id', ... }
                const classIdMap = {};
                let classesGenerated = 0;

                for (const oldClass of oldClasses) {
                    // Check if standard "Draft Year Collision" exists
                    const existingNewClass = newClassesExist.find(
                        nc => nc.value === oldClass.value &&
                            nc.section === oldClass.section &&
                            nc.branch === oldClass.branch
                    );

                    if (existingNewClass) {
                        classIdMap[oldClass._id.toString()] = existingNewClass._id;
                    } else {
                        // Deep clone class for the new year
                        const newClass = new Class({
                            value: oldClass.value,
                            label: oldClass.label,
                            name: oldClass.name, // legacy fallback
                            section: oldClass.section,
                            branch: oldClass.branch,
                            academicYear: nextYearId,
                            classTeacher: null // Wipe teacher, let admin reassign
                        });
                        const savedClass = await newClass.save();
                        classIdMap[oldClass._id.toString()] = savedClass._id;
                        classesGenerated++;
                    }
                }
                console.log(`[TRANSITION] Classes Generated: ${classesGenerated}`);

                // 2. SUBJECT DEPENDENCY RESOLUTION & CLONING
                const oldSubjects = await Subject.find({ academicYear: currentYearId }).lean();
                let subjectsGenerated = 0;

                for (const oldSubject of oldSubjects) {
                    const mappedNewClassId = classIdMap[oldSubject.class.toString()];

                    if (mappedNewClassId) {
                        // Check for draft collision map
                        const existingSubject = await Subject.findOne({
                            name: oldSubject.name,
                            class: mappedNewClassId,
                            academicYear: nextYearId
                        });

                        if (!existingSubject) {
                            const newSubject = new Subject({
                                name: oldSubject.name,
                                class: mappedNewClassId,
                                academicYear: nextYearId,
                                teachers: [] // Wipe teachers array
                            });
                            await newSubject.save();
                            subjectsGenerated++;
                        }
                    }
                }
                console.log(`[TRANSITION] Subjects Generated: ${subjectsGenerated}`);

                // 3. STUDENT ARCHIVING (StudentHistory generation)
                const students = await User.find({
                    role: 'student',
                    academicYear: currentYearId
                }).populate('currentClass');

                // Calculate student attendance percentages for the outgoing year
                const attendanceStats = await Attendance.aggregate([
                    {
                        $match: {
                            academicYear: currentYear._id,
                            role: 'student'
                        }
                    },
                    {
                        $group: {
                            _id: '$user',
                            totalDays: { $sum: 1 },
                            presentDays: {
                                $sum: {
                                    $cond: [
                                        { $in: ['$status', ['present', 'late', 'excused']] },
                                        1,
                                        0
                                    ]
                                }
                            }
                        }
                    }
                ]);
                const attendanceMap = {};
                attendanceStats.forEach(stat => {
                    const pct = stat.totalDays > 0 ? parseFloat(((stat.presentDays / stat.totalDays) * 100).toFixed(1)) : 100;
                    attendanceMap[stat._id.toString()] = pct;
                });

                const historyRecords = students.map(student => {
                    const studentPlan = promotionPlan.find(p => p.studentId === student._id.toString());
                    let result = 'Promoted';
                    if (student.promotionStatus === 'detained') {
                        result = 'Detained';
                    } else if (studentPlan && studentPlan.status === 'graduated') {
                        result = 'Graduated';
                    }
                    const attendancePct = attendanceMap[student._id.toString()] !== undefined
                        ? attendanceMap[student._id.toString()]
                        : 100;

                    return {
                        student: student._id,
                        class: student.currentClass ? student.currentClass._id : null,
                        academicYear: currentYear._id,
                        result,
                        finalGrade: '',
                        totalAttendancePercentage: attendancePct
                    };
                }).filter(record => record.class !== null);

                if (historyRecords.length > 0) {
                    await StudentHistory.insertMany(historyRecords);
                    console.log(`[TRANSITION] History Records Saved: ${historyRecords.length}`);
                }

                // 4. STUDENT PROMOTION ENGINE
                let promotedCount = 0;
                let graduatedCount = 0;
                let detainedCount = 0;

                for (const plan of promotionPlan) {
                    const student = await User.findById(plan.studentId);
                    if (!student) continue;

                    if (student.promotionStatus === 'detained') {
                        // Safe mapping utilizing original class ID from populated object
                        const originalClassId = student.currentClass ? student.currentClass._id.toString() : null;
                        const targetClassId = originalClassId ? classIdMap[originalClassId] : null;
                        student.currentClass = targetClassId || null;
                        student.promotionStatus = 'promoted'; // Reset flag for new year
                        detainedCount++;
                    } else if (plan.status === 'graduated') {
                        student.currentClass = null;
                        student.isActive = false;
                        student.role = 'alumni'; // Promote to alumni role
                        graduatedCount++;
                    } else if (plan.nextClassId) {
                        student.currentClass = plan.nextClassId;
                        promotedCount++;
                    }

                    // Push them universally into the new temporal dimension
                    student.academicYear = nextYear._id;
                    await student.save();
                }
                console.log(`[TRANSITION] Users Shifted. Promoted: ${promotedCount} | Detained: ${detainedCount} | Graduated (→ Alumni): ${graduatedCount}`);

                // 4b. TEACHER HISTORY ARCHIVE
                try {
                    const TeacherHistory = require('../models/TeacherHistory');

                    // Find all teacher-subject assignments and classes for the outgoing year
                    const subjects = await Subject.find({ academicYear: currentYear._id }).lean();
                    const classes = await Class.find({ academicYear: currentYear._id }).lean();

                    // Build a map: teacherId -> [{ class, subject, role }]
                    const teacherMap = new Map();

                    // 1. Archive Subject Teachers
                    for (const subj of subjects) {
                        if (subj.teachers && Array.isArray(subj.teachers)) {
                            for (const teacherId of subj.teachers) {
                                const tid = teacherId.toString();
                                if (!teacherMap.has(tid)) teacherMap.set(tid, []);
                                teacherMap.get(tid).push({
                                    class: subj.class,
                                    subject: subj._id,
                                    role: 'subject_teacher'
                                });
                            }
                        }
                    }

                    // 2. Archive Class Teachers
                    for (const cls of classes) {
                        if (cls.classTeacher) {
                            const tid = cls.classTeacher.toString();
                            if (!teacherMap.has(tid)) teacherMap.set(tid, []);
                            teacherMap.get(tid).push({
                                class: cls._id,
                                subject: null,
                                role: 'class_teacher'
                            });
                        }
                    }

                    // Bulk create TeacherHistory records
                    const historyOps = [];
                    for (const [teacherId, classesList] of teacherMap) {
                        historyOps.push({
                            updateOne: {
                                filter: { teacher: teacherId, academicYear: currentYear._id },
                                update: { $set: { teacher: teacherId, academicYear: currentYear._id, classes: classesList } },
                                upsert: true
                            }
                        });
                    }

                    if (historyOps.length > 0) {
                        await TeacherHistory.bulkWrite(historyOps);
                        console.log(`[TRANSITION] Archived ${historyOps.length} teacher portfolios.`);
                    }
                } catch (thErr) {
                    console.error('[TRANSITION] Teacher History archive warning:', thErr.message);
                }

                // 5. YEAR STATUS FLIP
                currentYear.status = 'archived';
                currentYear.promotedTo = nextYear._id;
                currentYear.isActive = false;
                await currentYear.save();

                nextYear.isActive = true;
                nextYear.status = 'current';
                nextYear.promotedFrom = currentYear._id;
                nextYear.transitionDate = new Date();
                nextYear.transitionBy = req.user.id;
                await nextYear.save();

                console.log(`[TRANSITION] COMPLETE. Welcome to ${nextYear.name}.`);

            } catch (bgErr) {
                console.error('[TRANSITION BACKGROUND TASK ERROR]', bgErr);
            }
        })();

    } catch (err) {
        console.error('Execute Transition Trigger Error:', err.message);
        res.status(500).json({ message: 'Error triggering transition process', error: err.message });
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

        // Clear any pre-existing exams in the next year
        const nextYearExams = await Exam.find({ academicYear: nextYear._id }).select('_id');
        const nextYearExamIds = nextYearExams.map(e => e._id);
        if (nextYearExamIds.length > 0) {
            await Marks.deleteMany({ exam: { $in: nextYearExamIds } });
            await Exam.deleteMany({ _id: { $in: nextYearExamIds } });
            console.log(`[LEGACY TRANSITION] Cleared ${nextYearExamIds.length} existing exams and their marks from target year ${nextYear.name}.`);
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
            const bulkOps = historyRecords.map(record => ({
                updateOne: {
                    filter: { student: record.student, academicYear: record.academicYear },
                    update: { $set: record },
                    upsert: true
                }
            }));
            await StudentHistory.bulkWrite(bulkOps);
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

        // Deactivate current year
        currentYear.isActive = false;
        currentYear.status = 'archived';
        await currentYear.save();

        // Activate next year
        nextYear.isActive = true;
        nextYear.status = 'current';
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
                applicantRole: { $in: ['teacher', 'staff'] },
                startDate: { $gte: year.startDate, $lte: year.endDate }
            }).populate('applicant', 'name role').lean(),
            Attendance.aggregate([
                {
                    $match: {
                        role: { $in: ['teacher', 'staff'] },
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
async function captureRollbackData(currentYearId, nextYearId) {
    const students = await User.find({
        role: 'student',
        academicYear: currentYearId
    }).lean();

    const currentYear = await AcademicYear.findById(currentYearId).lean();

    return {
        students,
        currentYear,
        nextYearId,
        timestamp: new Date()
    };
}

async function performRollback(rollbackData) {
    // Restore student data
    for (const student of rollbackData.students) {
        await User.findByIdAndUpdate(student._id, {
            academicYear: student.academicYear,
            currentClass: student.currentClass,
            isActive: student.isActive,
            role: student.role
        });
    }

    // Restore current year status
    await AcademicYear.findByIdAndUpdate(rollbackData.currentYear._id, {
        isActive: true,
        status: 'current',
        promotedTo: null
    });

    // Restore next year status and clean up cloned entities
    if (rollbackData.nextYearId) {
        await AcademicYear.findByIdAndUpdate(rollbackData.nextYearId, {
            isActive: false,
            status: 'draft',
            promotedFrom: null,
            transitionDate: null,
            transitionBy: null
        });

        // Delete cloned classes and subjects for the next academic year
        await Class.deleteMany({ academicYear: rollbackData.nextYearId });
        await Subject.deleteMany({ academicYear: rollbackData.nextYearId });

        // Delete exams and marks created in the next academic year during the transition
        const nextYearExams = await Exam.find({ academicYear: rollbackData.nextYearId }).select('_id');
        const nextYearExamIds = nextYearExams.map(e => e._id);
        if (nextYearExamIds.length > 0) {
            await Marks.deleteMany({ exam: { $in: nextYearExamIds } });
            await Exam.deleteMany({ _id: { $in: nextYearExamIds } });
            console.log(`[ROLLBACK] Cleared ${nextYearExamIds.length} exams and their marks from the next academic year.`);
        }

        // Delete history records created during transition
        await StudentHistory.deleteMany({ academicYear: rollbackData.currentYear._id });
        try {
            const TeacherHistory = require('../models/TeacherHistory');
            await TeacherHistory.deleteMany({ academicYear: rollbackData.currentYear._id });
        } catch (thErr) {
            console.error('[ROLLBACK] Teacher History delete error:', thErr.message);
        }
    }

    console.log('Rollback completed successfully');
}

module.exports = exports;
