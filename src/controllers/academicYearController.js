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
const { invalidateYearCache } = require('../middleware/yearContext');
const { invalidateDashboardCaches } = require('./dashboardController');
// NOTE: Rollback data is now persisted on the AcademicYear document (nextYear.rollbackData)
// instead of an in-memory Map, so it survives server restarts.

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

        // Move active students (not alumni) into the new academic year
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

        // Invalidate active year cache & dashboard stats
        invalidateYearCache();
        invalidateDashboardCaches().catch(() => {});

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
            // Persist to DB on the next year document so it survives server restarts
            await AcademicYear.findByIdAndUpdate(nextYearId, {
                rollbackData: {
                    token: rollbackToken,
                    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
                    snapshot: rollbackData
                }
            });
            console.log(`[TRANSITION] Rollback token generated and persisted to DB: ${rollbackToken}`);
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
                                        { $in: ['$status', ['present', 'half-day']] },
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

                // Invalidate active year cache & dashboard stats
                invalidateYearCache();
                invalidateDashboardCaches().catch(() => {});

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
        // Find the academic year that holds this rollback token in DB
        const yearWithRollback = await AcademicYear.findOne({ 'rollbackData.token': rollbackToken });

        if (!yearWithRollback || !yearWithRollback.rollbackData) {
            return res.status(404).json({ message: 'Rollback token not found or expired' });
        }

        if (new Date() > yearWithRollback.rollbackData.expiresAt) {
            // Clear the expired rollback data
            yearWithRollback.rollbackData = undefined;
            await yearWithRollback.save();
            return res.status(410).json({ message: 'Rollback window expired (24 hours)' });
        }

        // Perform rollback
        await performRollback(yearWithRollback.rollbackData.snapshot);

        // Invalidate active year cache & dashboard stats
        invalidateYearCache();
        invalidateDashboardCaches().catch(() => {});

        // Clear rollback data from DB after use
        yearWithRollback.rollbackData = undefined;
        await yearWithRollback.save();

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

        // Invalidate active year cache
        invalidateYearCache();

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

        const [history, exams, teacherLeaves, staffUsers, attendanceAgg, yearClasses] = await Promise.all([
            StudentHistory.find({ academicYear: academicYearId })
                .populate('student', 'name email phone rollNumber gender')
                .populate('class', 'name label section branch')
                .lean(),
            Exam.find({ academicYear: academicYearId }).lean(),
            LeaveRequest.find({
                applicantRole: { $in: ['teacher', 'staff', 'support_staff'] },
                startDate: { $gte: year.startDate, $lte: year.endDate }
            }).populate('applicant', 'name role').lean(),
            User.find({
                role: { $in: ['teacher', 'staff', 'support_staff'] }
            }).select('name email phone role designation').lean(),
            Attendance.aggregate([
                {
                    $match: {
                        role: { $in: ['teacher', 'staff', 'support_staff'] },
                        $or: [
                            { academicYear: year._id },
                            { date: { $gte: year.startDate, $lte: year.endDate } }
                        ]
                    }
                },
                {
                    $group: {
                        _id: '$user',
                        totalDays: { $sum: 1 },
                        presentDays: {
                            $sum: {
                                $cond: [{ $in: ['$status', ['present', 'half-day']] }, 1, 0]
                            }
                        },
                        absentDays: {
                            $sum: {
                                $cond: [{ $eq: ['$status', 'absent'] }, 1, 0]
                            }
                        },
                        halfDays: {
                            $sum: {
                                $cond: [{ $eq: ['$status', 'half-day'] }, 1, 0]
                            }
                        }
                    }
                },
                {
                    $lookup: {
                        from: 'users',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'userInfo'
                    }
                }
            ]),
            Class.find({ academicYear: academicYearId }).sort({ name: 1, label: 1, section: 1 }).lean()
        ]);

        const attendanceMap = new Map();
        attendanceAgg.forEach(stat => {
            attendanceMap.set(stat._id.toString(), stat);
        });

        // Consolidate per-staff attendance statistics
        const teacherAttendance = staffUsers.map(staff => {
            const stat = attendanceMap.get(staff._id.toString());
            const totalDays = stat?.totalDays || 0;
            const presentDays = stat?.presentDays || 0;
            const absentDays = stat?.absentDays || 0;
            const lateDays = stat?.lateDays || 0;
            const halfDays = stat?.halfDays || 0;
            const excusedDays = stat?.excusedDays || 0;
            const percentage = totalDays > 0 ? parseFloat(((presentDays / totalDays) * 100).toFixed(1)) : 0;

            return {
                userId: staff._id,
                _id: staff._id,
                user: staff.name,
                name: staff.name,
                email: staff.email,
                phone: staff.phone,
                role: staff.role,
                designation: staff.designation || null,
                totalDays,
                presentDays,
                absentDays,
                lateDays,
                halfDays,
                excusedDays,
                percentage
            };
        });

        // Include any attendance records for staff not in current staffUsers list (e.g. deactivated/alumni staff)
        attendanceAgg.forEach(stat => {
            const alreadyIncluded = teacherAttendance.some(t => t._id.toString() === stat._id.toString());
            if (!alreadyIncluded) {
                const totalDays = stat.totalDays || 0;
                const presentDays = stat.presentDays || 0;
                const percentage = totalDays > 0 ? parseFloat(((presentDays / totalDays) * 100).toFixed(1)) : 0;
                const name = stat.userInfo?.[0]?.name || 'Staff Member';
                teacherAttendance.push({
                    userId: stat._id,
                    _id: stat._id,
                    user: name,
                    name: name,
                    email: stat.userInfo?.[0]?.email,
                    role: stat.userInfo?.[0]?.role || 'staff',
                    designation: stat.userInfo?.[0]?.designation || null,
                    totalDays,
                    presentDays,
                    absentDays: stat.absentDays || 0,
                    lateDays: stat.lateDays || 0,
                    halfDays: stat.halfDays || 0,
                    excusedDays: stat.excusedDays || 0,
                    percentage
                });
            }
        });

        // Sort alphabetically by name
        teacherAttendance.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

        // Calculate summary statistics
        const trackedStaff = teacherAttendance.filter(t => t.totalDays > 0);
        const avgPercentage = trackedStaff.length > 0
            ? parseFloat((trackedStaff.reduce((sum, t) => sum + t.percentage, 0) / trackedStaff.length).toFixed(1))
            : 0;

        const teacherAttendanceSummary = {
            totalStaff: staffUsers.length,
            trackedStaff: trackedStaff.length,
            averagePercentage: avgPercentage,
            totalPresentDays: teacherAttendance.reduce((sum, t) => sum + t.presentDays, 0),
            totalAbsentDays: teacherAttendance.reduce((sum, t) => sum + t.absentDays, 0),
            totalLateDays: teacherAttendance.reduce((sum, t) => sum + t.lateDays, 0)
        };

        // Determine relevant classes
        let classesToUse = Array.isArray(yearClasses) ? [...yearClasses] : [];
        if (classesToUse.length === 0 && year.isActive) {
            classesToUse = await Class.find({
                $or: [
                    { academicYear: { $exists: false } },
                    { academicYear: null },
                    { academicYear: academicYearId }
                ]
            }).sort({ name: 1, label: 1, section: 1 }).lean();
        }

        const formatClassDisplayName = (cls) => {
            if (!cls) return 'Unassigned';
            const base = cls.label || cls.name || 'Unnamed Class';
            const sec = cls.section && !base.toLowerCase().includes(cls.section.toLowerCase()) ? ` - ${cls.section}` : '';
            const br = cls.branch && cls.branch !== 'Main' && !base.toLowerCase().includes(cls.branch.toLowerCase()) ? ` (${cls.branch})` : '';
            return `${base}${sec}${br}`.trim();
        };

        const classWiseStudents = {};

        // Pre-populate with all known classes for this academic year so they appear in distribution
        classesToUse.forEach(cls => {
            const displayName = formatClassDisplayName(cls);
            if (!classWiseStudents[displayName]) {
                classWiseStudents[displayName] = [];
            }
        });

        // 1. If we have archived StudentHistory records and year is not currently active, use StudentHistory
        if (history && history.length > 0 && !year.isActive) {
            history.forEach(curr => {
                const displayName = curr.class ? formatClassDisplayName(curr.class) : 'Unassigned';
                if (!classWiseStudents[displayName]) classWiseStudents[displayName] = [];
                if (curr.student) {
                    classWiseStudents[displayName].push(curr.student);
                }
            });
        } else {
            // 2. Otherwise (active academic year, or unarchived past/future year), fetch active student Users
            const classIds = classesToUse.map(c => c._id);
            const studentFilter = {
                role: 'student',
                isActive: { $ne: false },
                $or: [
                    { academicYear: year._id },
                    ...(classIds.length > 0 ? [{ currentClass: { $in: classIds } }] : []),
                    ...(year.isActive ? [{ currentClass: { $exists: true, $ne: null } }] : [])
                ]
            };

            const activeStudents = await User.find(studentFilter)
                .populate('currentClass', 'name label section branch')
                .select('name email phone rollNumber gender currentClass academicYear')
                .lean();

            if (activeStudents.length > 0) {
                activeStudents.forEach(student => {
                    const displayName = student.currentClass ? formatClassDisplayName(student.currentClass) : 'Unassigned';
                    if (!classWiseStudents[displayName]) classWiseStudents[displayName] = [];
                    classWiseStudents[displayName].push({
                        _id: student._id,
                        name: student.name,
                        email: student.email,
                        phone: student.phone,
                        rollNumber: student.rollNumber,
                        gender: student.gender
                    });
                });
            } else if (history && history.length > 0) {
                // Fallback to history if active students search returned nothing
                history.forEach(curr => {
                    const displayName = curr.class ? formatClassDisplayName(curr.class) : 'Unassigned';
                    if (!classWiseStudents[displayName]) classWiseStudents[displayName] = [];
                    if (curr.student) {
                        classWiseStudents[displayName].push(curr.student);
                    }
                });
            }
        }

        const examIds = exams.map(e => e._id);
        const marks = await Marks.find({ exam: { $in: examIds } })
            .populate('student', 'name')
            .populate('exam', 'name subject totalMarks')
            .lean();

        const totalStudents = Object.values(classWiseStudents).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
        const totalClassesCount = Object.keys(classWiseStudents).length;

        res.json({
            academicYear: year,
            classWiseStudents,
            totalStudents,
            totalClassesCount,
            marks,
            teacherLeaves,
            teacherAttendance,
            teacherAttendanceSummary
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
