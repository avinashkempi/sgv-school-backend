const mongoose = require('mongoose');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const FeePayment = require('../models/FeePayment');
const StudentFee = require('../models/StudentFee');
const Complaint = require('../models/Complaint');
const Marks = require('../models/Marks');
const Class = require('../models/Class');
const Exam = require('../models/Exam');
const AcademicYear = require('../models/AcademicYear');
const { cacheGet, cacheSet, cacheInvalidatePattern } = require('../config/redis');

// In-memory fallback caches
const adminStatsCache = new Map();
const teacherStatsCache = new Map();
const studentStatsCache = new Map();

const MEMORY_CACHE_TTL = 60 * 1000; // 60 seconds local fallback
const ADMIN_STATS_REDIS_TTL = 120; // 2 minutes
const TEACHER_STATS_REDIS_TTL = 120; // 2 minutes
const STUDENT_STATS_REDIS_TTL = 300; // 5 minutes

// Helper to calculate date range
const getDateRange = (range) => {
    const now = new Date();
    let startDate, endDate = new Date(now);

    switch (range) {
        case 'today':
            startDate = new Date(now);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(now);
            endDate.setHours(23, 59, 59, 999);
            break;
        case 'thisWeek': {
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - now.getDay());
            startOfWeek.setHours(0, 0, 0, 0);
            startDate = startOfWeek;
            break;
        }
        case 'last30Days':
            startDate = new Date(now);
            startDate.setDate(now.getDate() - 30);
            break;
        case 'thisYear':
            startDate = new Date(now.getFullYear(), 0, 1);
            break;
        case 'lastYear':
            startDate = new Date(now.getFullYear() - 1, 0, 1);
            endDate = new Date(now.getFullYear() - 1, 11, 31);
            break;
        case 'allTime':
            startDate = new Date(2020, 0, 1);
            break;
        case 'thisMonth':
        default:
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            break;
    }

    return { startDate, endDate };
};

// Admin Stats
exports.getAdminStats = async (req, res) => {
    try {
        const { range = 'thisMonth' } = req.query;
        const yearCtx = req.academicYearContext || (req.activeYear ? req.activeYear._id.toString() : 'default');
        const cacheKey = `adminStats:${range}:${yearCtx}`;

        // 1. Fast local memory cache check
        const memCached = adminStatsCache.get(cacheKey);
        if (memCached && Date.now() - memCached.ts < MEMORY_CACHE_TTL) {
            return res.json(memCached.data);
        }

        // 2. Redis cache check
        try {
            const redisData = await cacheGet(cacheKey);
            if (redisData) {
                adminStatsCache.set(cacheKey, { data: redisData, ts: Date.now() });
                return res.json(redisData);
            }
        } catch (_) {}

        const { startDate, endDate } = getDateRange(range);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Get previous period for trend calculation
        const periodDuration = endDate - startDate;
        const prevStartDate = new Date(startDate.getTime() - periodDuration);
        const prevEndDate = new Date(startDate);

        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

        // Parallel Execution - query both StudentFee.payments (imported) and FeePayment (app-recorded) using $facet
        const [
            totalStudents,
            totalTeachers,
            attendanceToday,
            combinedImportedFees,
            combinedAppFees,
            prevAttendance,
            recentComplaints,
            totalClasses,
            attendanceTodayTeacher,
            classesMarkedToday
        ] = await Promise.all([
            User.countDocuments({ role: 'student', academicYear: req.academicYearContext }),
            User.countDocuments({ role: 'teacher' }),
            Attendance.find({
                date: { $gte: today, $lt: tomorrow },
                role: 'student',
                academicYear: req.academicYearContext
            }).lean(),
            // Imported fees current + previous combined via $facet
            StudentFee.aggregate([
                { $match: { academicYear: new mongoose.Types.ObjectId(req.academicYearContext) } },
                { $unwind: "$payments" },
                {
                    $facet: {
                        current: [
                            { $match: { "payments.date": { $gte: startDate, $lte: endDate } } },
                            { $group: { _id: null, total: { $sum: "$payments.amount" } } }
                        ],
                        previous: [
                            { $match: { "payments.date": { $gte: prevStartDate, $lt: prevEndDate } } },
                            { $group: { _id: null, total: { $sum: "$payments.amount" } } }
                        ]
                    }
                }
            ]),
            // App-recorded fees current + previous combined via $facet
            FeePayment.aggregate([
                { 
                    $match: { 
                        status: 'success', 
                        academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                    } 
                },
                {
                    $facet: {
                        current: [
                            { $match: { paymentDate: { $gte: startDate, $lte: endDate } } },
                            { $group: { _id: null, total: { $sum: "$amount" } } }
                        ],
                        previous: [
                            { $match: { paymentDate: { $gte: prevStartDate, $lt: prevEndDate } } },
                            { $group: { _id: null, total: { $sum: "$amount" } } }
                        ]
                    }
                }
            ]),
            Attendance.find({
                date: { $gte: prevStartDate, $lt: prevEndDate },
                role: 'student',
                academicYear: req.academicYearContext
            }).lean(),
            Complaint.find()
                .sort({ createdAt: -1 })
                .limit(5)
                .populate('student', 'name')
                .select('title status student createdAt')
                .lean(),
            Class.countDocuments({ academicYear: req.academicYearContext }),
            Attendance.find({
                date: { $gte: today, $lt: tomorrow },
                role: 'teacher'
            }).lean(),
            Attendance.distinct('class', {
                date: { $gte: today, $lt: tomorrow },
                role: 'student',
                class: { $ne: null },
                academicYear: req.academicYearContext
            })
        ]);

        const presentCount = attendanceToday.filter(a => ['present', 'late', 'excused'].includes(a.status)).length;
        const absentCount = attendanceToday.filter(a => a.status === 'absent').length;
        const attendancePercentage = totalStudents > 0
            ? ((presentCount / totalStudents) * 100).toFixed(1)
            : 0;

        const teacherPresentCount = attendanceTodayTeacher.filter(a => ['present', 'late', 'excused'].includes(a.status)).length;
        const teacherAbsentCount = attendanceTodayTeacher.filter(a => a.status === 'absent').length;

        // Calculate attendance trend
        const prevPresentCount = prevAttendance.filter(a => ['present', 'late', 'excused'].includes(a.status)).length;
        const prevAttendancePercentage = totalStudents > 0
            ? ((prevPresentCount / totalStudents) * 100)
            : 0;
        const attendanceTrend = (attendancePercentage - prevAttendancePercentage).toFixed(1);

        // Combine imported + app-recorded fees from facet results
        const currentImported = combinedImportedFees[0]?.current[0]?.total || 0;
        const prevImported = combinedImportedFees[0]?.previous[0]?.total || 0;
        const currentApp = combinedAppFees[0]?.current[0]?.total || 0;
        const prevApp = combinedAppFees[0]?.previous[0]?.total || 0;

        const totalCollected = currentImported + currentApp;
        const prevTotalCollected = prevImported + prevApp;
        const feeCollectionTrend = prevTotalCollected > 0
            ? (((totalCollected - prevTotalCollected) / prevTotalCollected) * 100).toFixed(1)
            : 0;

        // Fee Trend Logic - show all months of academic year
        const activeYear = req.activeYear || await AcademicYear.findById(req.academicYearContext).lean();
        let feeTrend = [];

        if (activeYear) {
            const ayStartYear = new Date(activeYear.startDate).getFullYear();
            const ayStart = new Date(ayStartYear, 4, 1); // May 1st
            const ayEnd = new Date(ayStartYear + 1, 3, 30); // April 30th next year

            // Fixed May to April months
            const allMonths = [
                { year: ayStartYear, month: 5 },   // May
                { year: ayStartYear, month: 6 },   // Jun
                { year: ayStartYear, month: 7 },   // Jul
                { year: ayStartYear, month: 8 },   // Aug
                { year: ayStartYear, month: 9 },   // Sep
                { year: ayStartYear, month: 10 },  // Oct
                { year: ayStartYear, month: 11 },  // Nov
                { year: ayStartYear, month: 12 },  // Dec
                { year: ayStartYear + 1, month: 1 },  // Jan
                { year: ayStartYear + 1, month: 2 },  // Feb
                { year: ayStartYear + 1, month: 3 },  // Mar
                { year: ayStartYear + 1, month: 4 },  // Apr
            ];

            // Query both sources for the full academic year range
            const [importedFeeTrend, appFeeTrend] = await Promise.all([
                StudentFee.aggregate([
                    { $match: { academicYear: new mongoose.Types.ObjectId(req.academicYearContext) } },
                    { $unwind: "$payments" },
                    { $match: { "payments.date": { $gte: ayStart, $lte: ayEnd } } },
                    {
                        $group: {
                            _id: { year: { $year: "$payments.date" }, month: { $month: "$payments.date" } },
                            total: { $sum: "$payments.amount" }
                        }
                    }
                ]),
                FeePayment.aggregate([
                    { 
                        $match: { 
                            status: 'success', 
                            paymentDate: { $gte: ayStart, $lte: ayEnd },
                            academicYear: new mongoose.Types.ObjectId(req.academicYearContext)
                        } 
                    },
                    {
                        $group: {
                            _id: { year: { $year: "$paymentDate" }, month: { $month: "$paymentDate" } },
                            total: { $sum: "$amount" }
                        }
                    }
                ])
            ]);

            // Merge both into a map keyed by "year-month"
            const feeTrendMap = {};
            importedFeeTrend.forEach(f => {
                const key = `${f._id.year}-${f._id.month}`;
                feeTrendMap[key] = (feeTrendMap[key] || 0) + f.total;
            });
            appFeeTrend.forEach(f => {
                const key = `${f._id.year}-${f._id.month}`;
                feeTrendMap[key] = (feeTrendMap[key] || 0) + f.total;
            });

            // Build final array with all months, filling 0 where no data
            feeTrend = allMonths.map(m => ({
                month: monthNames[m.month - 1],
                amount: feeTrendMap[`${m.year}-${m.month}`] || 0
            }));
        }

        const responseData = {
            overview: {
                totalStudents,
                totalTeachers,
                attendancePercentage: parseFloat(attendancePercentage),
                attendanceTrend: parseFloat(attendanceTrend),
                totalCollected,
                feeCollectionTrend: parseFloat(feeCollectionTrend)
            },
            charts: {
                attendance: {
                    student: {
                        present: presentCount,
                        absent: absentCount,
                        total: totalStudents
                    },
                    teacher: {
                        present: teacherPresentCount,
                        absent: teacherAbsentCount,
                        total: totalTeachers
                    },
                    classesMarked: {
                        count: classesMarkedToday.length,
                        total: totalClasses
                    }
                },
                feeTrend
            },
            recentComplaints
        };

        adminStatsCache.set(cacheKey, { data: responseData, ts: Date.now() });
        cacheSet(cacheKey, responseData, ADMIN_STATS_REDIS_TTL).catch(() => {});
        res.json(responseData);

    } catch (error) {
        console.error('Admin Dashboard Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// Teacher Stats
exports.getTeacherStats = async (req, res) => {
    try {
        const teacherId = req.user.userId;
        const range = req.query.range || 'thisWeek';
        const yearCtx = req.academicYearContext || (req.activeYear ? req.activeYear._id.toString() : 'default');
        const cacheKey = `teacherStats:${teacherId}:${range}:${yearCtx}`;

        // 1. Fast local memory cache check
        const memCached = teacherStatsCache.get(cacheKey);
        if (memCached && Date.now() - memCached.ts < MEMORY_CACHE_TTL) {
            return res.json(memCached.data);
        }

        // 2. Redis cache check
        try {
            const redisData = await cacheGet(cacheKey);
            if (redisData) {
                teacherStatsCache.set(cacheKey, { data: redisData, ts: Date.now() });
                return res.json(redisData);
            }
        } catch (_) {}

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const currentDay = days[today.getDay()];

        // 1. Fetch My Class (as class teacher) & all timetables in parallel
        const Timetable = require('../models/Timetable');
        const [myClass, allTeacherTimetables] = await Promise.all([
            Class.findOne({ classTeacher: teacherId }).lean(),
            Timetable.find({
                "schedule.periods.teacher": teacherId
            }).populate('class', 'name section').lean()
        ]);

        const activeYear = req.activeYear;

        // Calculate classes today & total distinct classes from single query result
        let classesTodayCount = 0;
        const teacherClassIds = new Set();

        allTeacherTimetables.forEach(tt => {
            if (tt.class) teacherClassIds.add(tt.class._id.toString());
            const daySchedule = tt.schedule?.find(s => s.day === currentDay);
            if (daySchedule && daySchedule.periods) {
                classesTodayCount += daySchedule.periods.filter(p => p.teacher && p.teacher.toString() === teacherId).length;
            }
        });

        const totalClassesTaught = teacherClassIds.size;

        let myStudentCount = 0;
        let lowAttendanceCount = 0;
        let className = null;
        let classAttendance = null;
        let attendanceTrendLabels = [];
        let attendanceTrendData = [];

        if (myClass) {
            className = `${myClass.name} ${myClass.section || ''}`.trim();

            // Get students of this class
            const students = await User.find({ currentClass: myClass._id, role: 'student' }).select('_id').lean();
            const studentIds = students.map(s => s._id);
            myStudentCount = studentIds.length;

            // 3. Today's class attendance summary
            const todayFilter = {
                class: myClass._id,
                date: today,
                role: 'student'
            };
            if (activeYear) todayFilter.academicYear = activeYear._id;

            const todayAttendance = await Attendance.find(todayFilter).lean();

            const presentCount = todayAttendance.filter(a => ['present', 'late', 'excused'].includes(a.status)).length;
            const absentCount = todayAttendance.filter(a => a.status === 'absent').length;
            const lateCount = todayAttendance.filter(a => a.status === 'late').length;
            const excusedCount = todayAttendance.filter(a => a.status === 'excused').length;

            classAttendance = {
                present: presentCount,
                absent: absentCount,
                late: lateCount,
                excused: excusedCount,
                total: myStudentCount,
                marked: todayAttendance.length,
                date: today.toISOString().split('T')[0]
            };

            // 4. Low Attendance Students (< 75%) — last 30 days
            const { startDate: low30Start, endDate: low30End } = getDateRange('last30Days');

            const lowAttFilter = {
                user: { $in: studentIds },
                date: { $gte: low30Start, $lte: low30End },
                role: 'student'
            };
            if (activeYear) lowAttFilter.academicYear = activeYear._id;

            const attendanceStats = await Attendance.aggregate([
                {
                    $match: lowAttFilter
                },
                {
                    $group: {
                        _id: "$user",
                        total: { $sum: 1 },
                        present: {
                            $sum: {
                                $cond: [{ $in: ["$status", ["present", "late", "excused"]] }, 1, 0]
                            }
                        }
                    }
                }
            ]);

            lowAttendanceCount = attendanceStats.filter(stat => {
                const pct = stat.total > 0 ? (stat.present / stat.total) * 100 : 0;
                return pct < 75;
            }).length;

            // 5. Attendance Trend — Last 7 working days
            const trendDays = [];
            let d = new Date(today);
            while (trendDays.length < 7) {
                d.setDate(d.getDate() - 1);
                if (d.getDay() !== 0) { // Skip Sunday
                    trendDays.push(new Date(d));
                }
            }
            trendDays.reverse(); // oldest first

            const trendStart = trendDays[0];
            const trendEnd = new Date(today);
            trendEnd.setHours(23, 59, 59, 999);

            const trendFilter = {
                user: { $in: studentIds },
                date: { $gte: trendStart, $lte: trendEnd },
                role: 'student'
            };
            if (activeYear) trendFilter.academicYear = activeYear._id;

            const trendStats = await Attendance.aggregate([
                {
                    $match: trendFilter
                },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                        presentCount: {
                            $sum: {
                                $cond: [{ $in: ["$status", ["present", "late", "excused"]] }, 1, 0]
                            }
                        },
                        totalCount: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            const trendMap = {};
            trendStats.forEach(s => {
                trendMap[s._id] = s.totalCount > 0 ? Math.round((s.presentCount / s.totalCount) * 100) : 0;
            });

            trendDays.forEach(day => {
                const key = day.toISOString().split('T')[0];
                const label = day.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
                attendanceTrendLabels.push(label);
                attendanceTrendData.push(trendMap[key] || 0);
            });
        }

        // 6. Performance Charts (Avg Marks per Subject)
        const teacherUser = await User.findById(teacherId).populate('subjects');
        let subjectPerformanceLabels = [];
        let subjectPerformanceData = [];

        if (teacherUser && teacherUser.subjects && teacherUser.subjects.length > 0) {
            const subjectIds = teacherUser.subjects.map(s => s._id);

            const marksStats = await Marks.aggregate([
                {
                    $lookup: {
                        from: 'exams',
                        localField: 'exam',
                        foreignField: '_id',
                        as: 'examDetails'
                    }
                },
                { $unwind: '$examDetails' },
                {
                    $match: {
                        'examDetails.subject': { $in: subjectIds }
                    }
                },
                {
                    $group: {
                        _id: '$examDetails.subject',
                        avgMarks: { $avg: '$marksObtained' }
                    }
                }
            ]);

            teacherUser.subjects.forEach(sub => {
                const stat = marksStats.find(m => m._id.toString() === sub._id.toString());
                if (stat) {
                    subjectPerformanceLabels.push(sub.name.substring(0, 10));
                    subjectPerformanceData.push(Math.round(stat.avgMarks));
                }
            });

        } else if (myClass) {
            // Fallback: Show class performance across subjects
            const students = await User.find({ currentClass: myClass._id, role: 'student' }).select('_id');
            const studentIds = students.map(s => s._id);

            const classStats = await Marks.aggregate([
                { $match: { student: { $in: studentIds } } },
                {
                    $lookup: {
                        from: 'exams',
                        localField: 'exam',
                        foreignField: '_id',
                        as: 'examDetails'
                    }
                },
                { $unwind: '$examDetails' },
                {
                    $lookup: {
                        from: 'subjects',
                        localField: 'examDetails.subject',
                        foreignField: '_id',
                        as: 'subjectDetails'
                    }
                },
                { $unwind: '$subjectDetails' },
                {
                    $group: {
                        _id: '$subjectDetails.name',
                        avgMarks: { $avg: '$marksObtained' }
                    }
                },
                { $limit: 5 }
            ]);

            classStats.forEach(stat => {
                subjectPerformanceLabels.push(stat._id);
                subjectPerformanceData.push(Math.round(stat.avgMarks));
            });
        }

        const responseData = {
            overview: {
                classesToday: classesTodayCount,
                totalClassesTaught: totalClassesTaught,
                myStudents: myStudentCount,
                lowAttendanceCount: lowAttendanceCount,
                className: className
            },
            classAttendance: classAttendance,
            charts: {
                performance: {
                    labels: subjectPerformanceLabels.length > 0 ? subjectPerformanceLabels : [],
                    data: subjectPerformanceData.length > 0 ? subjectPerformanceData : []
                },
                attendanceTrend: {
                    labels: attendanceTrendLabels,
                    data: attendanceTrendData
                }
            }
        };

        teacherStatsCache.set(cacheKey, { data: responseData, ts: Date.now() });
        cacheSet(cacheKey, responseData, TEACHER_STATS_REDIS_TTL).catch(() => {});
        res.json(responseData);

    } catch (error) {
        console.error('Teacher Stats Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// Student Stats
exports.getStudentStats = async (req, res) => {
    try {
        const studentId = req.user.userId;
        const activeYear = req.activeYear;
        const yearCtx = req.academicYearContext || (activeYear ? activeYear._id.toString() : 'default');
        const cacheKey = `studentStats:${studentId}:${yearCtx}`;

        // 1. Fast local memory cache check
        const memCached = studentStatsCache.get(cacheKey);
        if (memCached && Date.now() - memCached.ts < MEMORY_CACHE_TTL) {
            return res.json(memCached.data);
        }

        // 2. Redis cache check
        try {
            const redisData = await cacheGet(cacheKey);
            if (redisData) {
                studentStatsCache.set(cacheKey, { data: redisData, ts: Date.now() });
                return res.json(redisData);
            }
        } catch (_) {}

        // Get student info (class)
        const classId = req.user.currentClass || (await User.findById(studentId).select('currentClass').lean())?.currentClass;

        // Academic year date range for attendance
        let ayStart = null, ayEnd = new Date();
        if (activeYear?.startDate) {
            ayStart = new Date(activeYear.startDate);
        } else {
            // Fallback: start of current calendar year
            ayStart = new Date(new Date().getFullYear(), 0, 1);
        }

        const [
            totalDays,
            presentDays,
            prevTotalDays,
            prevPresentDays,
            studentFeeRecord,
            appPayments,
            recentMarks,
            nextExam
        ] = await Promise.all([
            // Attendance for full academic year
            Attendance.countDocuments({
                user: studentId,
                role: 'student',
                date: { $gte: ayStart, $lte: ayEnd }
            }),
            Attendance.countDocuments({
                user: studentId,
                role: 'student',
                status: 'present',
                date: { $gte: ayStart, $lte: ayEnd }
            }),
            // Previous month for trend
            Attendance.countDocuments({
                user: studentId,
                role: 'student',
                date: {
                    $gte: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1),
                    $lt: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                }
            }),
            Attendance.countDocuments({
                user: studentId,
                role: 'student',
                status: 'present',
                date: {
                    $gte: new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1),
                    $lt: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
                }
            }),
            // Fee record - total pending irrespective of date
            require('../models/StudentFee').findOne({
                student: studentId,
                ...(activeYear ? { academicYear: activeYear._id } : {})
            }).select('pendingAmount totalFees totalPaid concession toPay').lean(),
            // App-recorded payments (recorded after CSV import)
            FeePayment.aggregate([
                { $match: { student: new (require('mongoose').Types.ObjectId)(studentId), status: 'success' } },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]),
            // Performance trend — average % per standardized exam type (FA1, FA2, SA1, FA3, FA4, SA2)
            Marks.aggregate([
                { $match: { student: new (require('mongoose').Types.ObjectId)(studentId) } },
                {
                    $lookup: {
                        from: 'exams',
                        localField: 'exam',
                        foreignField: '_id',
                        as: 'examDetails'
                    }
                },
                { $unwind: '$examDetails' },
                {
                    $match: {
                        'examDetails.standardizedType': { $exists: true, $ne: null }
                    }
                },
                {
                    $group: {
                        _id: '$examDetails.standardizedType',
                        avgPercentage: {
                            $avg: {
                                $multiply: [
                                    { $divide: ['$marksObtained', '$examDetails.totalMarks'] },
                                    100
                                ]
                            }
                        },
                        subjectCount: { $sum: 1 }
                    }
                }
            ]),
            // Next exam filtered to student's class
            classId
                ? Exam.findOne({
                    examDate: { $gte: new Date() },
                    class: classId
                }).sort({ examDate: 1 }).select('examDate name').lean()
                : Exam.findOne({
                    examDate: { $gte: new Date() }
                }).sort({ examDate: 1 }).select('examDate name').lean()
        ]);

        // 1. Attendance % (academic year)
        const attendancePercentage = totalDays > 0 ? ((presentDays / totalDays) * 100).toFixed(1) : 0;
        const prevAttendancePercentage = prevTotalDays > 0 ? ((prevPresentDays / prevTotalDays) * 100) : 0;
        const attendanceTrend = (attendancePercentage - prevAttendancePercentage).toFixed(1);

        // 2. Fee Due - use pendingAmount from StudentFee (source of truth)
        const dueAmount = studentFeeRecord ? (studentFeeRecord.pendingAmount || 0) : Math.max(0, - (appPayments[0]?.total || 0));

        // 3. Performance trend — exam-type wise, ordered FA1 → FA2 → SA1 → FA3 → FA4 → SA2
        const EXAM_ORDER = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
        const examTypeMap = {};
        recentMarks.forEach(m => {
            examTypeMap[m._id] = parseFloat(m.avgPercentage.toFixed(1));
        });
        const performanceTrend = EXAM_ORDER
            .filter(type => examTypeMap[type] !== undefined)
            .map(type => ({
                examType: type,
                percentage: examTypeMap[type],
                subjectCount: recentMarks.find(m => m._id === type)?.subjectCount || 0
            }));

        // 4. Next Exam Date
        const nextExamDate = nextExam
            ? new Date(nextExam.examDate).toISOString().split('T')[0]
            : null;

        const responseData = {
            overview: {
                attendancePercentage: parseFloat(attendancePercentage),
                attendanceTrend: parseFloat(attendanceTrend),
                dueAmount,
                totalFees: studentFeeRecord?.totalFees || 0,
                toPay: studentFeeRecord?.toPay || Math.max(0, (studentFeeRecord?.totalFees || 0) - (studentFeeRecord?.concession || 0)),
                concession: studentFeeRecord?.concession || 0,
                totalPaid: studentFeeRecord?.totalPaid || 0,
                nextExamDate,
                nextExamName: nextExam?.name || null
            },
            charts: {
                performanceTrend
            }
        };

        studentStatsCache.set(cacheKey, { data: responseData, ts: Date.now() });
        cacheSet(cacheKey, responseData, STUDENT_STATS_REDIS_TTL).catch(() => {});
        res.json(responseData);

    } catch (error) {
        console.error('Student Dashboard Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

/**
 * Invalidate all dashboard caches across in-memory and Redis
 */
exports.invalidateDashboardCaches = async () => {
    adminStatsCache.clear();
    teacherStatsCache.clear();
    studentStatsCache.clear();
    try {
        await Promise.all([
            cacheInvalidatePattern('adminStats:*'),
            cacheInvalidatePattern('teacherStats:*'),
            cacheInvalidatePattern('studentStats:*')
        ]);
    } catch (_) {}
};

/**
 * Invalidate specific teacher dashboard cache
 */
exports.invalidateTeacherDashboard = async (teacherId) => {
    teacherStatsCache.clear();
    try {
        await cacheInvalidatePattern(`teacherStats:${teacherId}:*`);
    } catch (_) {}
};

/**
 * Invalidate specific student dashboard cache
 */
exports.invalidateStudentDashboard = async (studentId) => {
    studentStatsCache.clear();
    try {
        await cacheInvalidatePattern(`studentStats:${studentId}:*`);
    } catch (_) {}
};
