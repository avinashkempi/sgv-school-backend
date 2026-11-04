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
const Subject = require('../models/Subject');
const StudentRating = require('../models/StudentRating');
const {
    getISTDateString,
    getISTDayBounds,
    getISTMonthBounds,
    getISTMonthYear,
    isISTSunday
} = require('../utils/dateUtils');
const { cacheGet, cacheSet, cacheInvalidatePattern } = require('../config/redis');

/**
 * Bounded in-memory cache with size limits, LRU eviction, and TTL checks.
 * Prevents memory leaks under high concurrent users while providing <0.01ms reads.
 */
class BoundedCache {
    constructor(maxSize = 200, ttlMs = 60 * 1000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.map = new Map();
    }

    get(key) {
        const item = this.map.get(key);
        if (!item) return null;
        if (Date.now() - item.ts > this.ttlMs) {
            this.map.delete(key);
            return null;
        }
        // Refresh recency for LRU
        this.map.delete(key);
        this.map.set(key, item);
        return item;
    }

    set(key, value) {
        if (this.map.has(key)) {
            this.map.delete(key);
        } else if (this.map.size >= this.maxSize) {
            const oldestKey = this.map.keys().next().value;
            if (oldestKey !== undefined) {
                this.map.delete(oldestKey);
            }
        }
        const entry = (value && typeof value === 'object' && 'data' in value && 'ts' in value)
            ? value
            : { data: value, ts: Date.now() };
        this.map.set(key, entry);
    }

    delete(key) {
        this.map.delete(key);
    }

    deletePrefix(prefix) {
        for (const key of this.map.keys()) {
            if (key.startsWith(prefix)) {
                this.map.delete(key);
            }
        }
    }

    clear() {
        this.map.clear();
    }

    keys() {
        return this.map.keys();
    }
}

const MEMORY_CACHE_TTL = 60 * 1000; // 60 seconds local fallback
const ADMIN_STATS_REDIS_TTL = 120; // 2 minutes
const TEACHER_STATS_REDIS_TTL = 120; // 2 minutes
const STUDENT_STATS_REDIS_TTL = 300; // 5 minutes

// In-memory fallback caches bounded to prevent memory leaks
const adminStatsCache = new BoundedCache(50, MEMORY_CACHE_TTL);
const teacherStatsCache = new BoundedCache(200, MEMORY_CACHE_TTL);
const studentStatsCache = new BoundedCache(500, MEMORY_CACHE_TTL);

// Helper to calculate date range in Asia/Kolkata
const getDateRange = (range) => {
    const { year: curYear, month: curMonth } = getISTMonthYear();
    const { startOfDay: todayStart, endOfDay: todayEnd } = getISTDayBounds();

    let startDate;
    let endDate = todayEnd;

    switch (range) {
        case 'today':
            startDate = todayStart;
            endDate = todayEnd;
            break;
        case 'thisWeek': {
            // Monday as start of week in IST
            const dateStr = getISTDateString();
            const refDate = new Date(`${dateStr}T12:00:00+05:30`);
            const dayOfWeek = refDate.getDay(); // 0 is Sun, 1 is Mon...
            const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
            const mondayTimestamp = refDate.getTime() - diffToMonday * 24 * 60 * 60 * 1000;
            const mondayStr = getISTDateString(new Date(mondayTimestamp));
            startDate = getISTDayBounds(mondayStr).startOfDay;
            endDate = todayEnd;
            break;
        }
        case 'last30Days':
            startDate = new Date(todayStart.getTime() - 29 * 24 * 60 * 60 * 1000);
            endDate = todayEnd;
            break;
        case 'thisYear':
            startDate = new Date(`${curYear}-01-01T00:00:00+05:30`);
            endDate = todayEnd;
            break;
        case 'lastYear':
            startDate = new Date(`${curYear - 1}-01-01T00:00:00+05:30`);
            endDate = new Date(`${curYear - 1}-12-31T23:59:59.999+05:30`);
            break;
        case 'allTime':
            startDate = new Date('2020-01-01T00:00:00+05:30');
            endDate = todayEnd;
            break;
        case 'thisMonth':
        default: {
            const monthBounds = getISTMonthBounds(curYear, curMonth);
            startDate = monthBounds.startOfMonth;
            endDate = todayEnd;
            break;
        }
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

        const { startOfDay: today } = getISTDayBounds();
        const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

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

        const presentCount = attendanceToday.filter(a => ['present', 'half-day'].includes(a.status)).length;
        const absentCount = attendanceToday.filter(a => a.status === 'absent').length;
        const attendancePercentage = totalStudents > 0
            ? ((presentCount / totalStudents) * 100).toFixed(1)
            : 0;

        const teacherPresentCount = attendanceTodayTeacher.filter(a => ['present', 'half-day'].includes(a.status)).length;
        const teacherAbsentCount = attendanceTodayTeacher.filter(a => a.status === 'absent').length;

        // Calculate attendance trend
        const prevPresentCount = prevAttendance.filter(a => ['present', 'half-day'].includes(a.status)).length;
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
        const requestedClassId = req.query.classId;
        const cacheKey = `teacherStats:${teacherId}:${range}:${yearCtx}:${requestedClassId || 'default'}`;

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

        const { startOfDay: today } = getISTDayBounds();
        const currentDay = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' }).format(new Date());

        const activeYear = req.activeYear || (req.academicYearContext ? { _id: req.academicYearContext } : await AcademicYear.findOne({ isActive: true }).lean());
        const yearId = req.academicYearContext || activeYear?._id;

        const classTeacherQuery = { classTeacher: teacherId };
        if (yearId) {
            classTeacherQuery.academicYear = yearId;
        }

        // 1. Fetch ALL Classes where user is class teacher & all timetables in parallel
        const Timetable = require('../models/Timetable');
        const [myClasses, allTeacherTimetables] = await Promise.all([
            Class.find(classTeacherQuery).sort({ name: 1, section: 1 }).lean(),
            Timetable.find({
                "schedule.periods.teacher": teacherId
            }).populate('class', 'name section').lean()
        ]);

        // Select the active class for class-teacher metrics
        let myClass = null;
        if (myClasses && myClasses.length > 0) {
            if (requestedClassId) {
                myClass = myClasses.find(c => c._id.toString() === requestedClassId) || myClasses[0];
            } else {
                myClass = myClasses[0];
            }
        }

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

            const presentCount = todayAttendance.filter(a => ['present', 'half-day'].includes(a.status)).length;
            const absentCount = todayAttendance.filter(a => a.status === 'absent').length;
            const halfDayCount = todayAttendance.filter(a => a.status === 'half-day').length;

            classAttendance = {
                present: presentCount,
                absent: absentCount,
                halfDay: halfDayCount,
                total: myStudentCount,
                marked: todayAttendance.length,
                date: getISTDateString(today)
            };

            // 4. Low Attendance Students (< 90%) — last 30 days
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
                                $cond: [{ $in: ["$status", ["present", "half-day"]] }, 1, 0]
                            }
                        }
                    }
                }
            ]);

            lowAttendanceCount = attendanceStats.filter(stat => {
                const pct = stat.total > 0 ? (stat.present / stat.total) * 100 : 0;
                return pct < 90;
            }).length;

            // 5. Attendance Trend — Last 7 working days in IST
            const trendDays = [];
            let checkTime = today.getTime();
            while (trendDays.length < 7) {
                checkTime -= 24 * 60 * 60 * 1000;
                const dStr = getISTDateString(new Date(checkTime));
                if (!isISTSunday(dStr)) {
                    trendDays.push(getISTDayBounds(dStr).startOfDay);
                }
            }
            trendDays.reverse(); // oldest first

            const trendStart = trendDays[0];
            const trendEnd = getISTDayBounds(today).endOfDay;

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
                                $cond: [{ $in: ["$status", ["present", "half-day"]] }, 1, 0]
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
                const key = getISTDateString(day);
                const label = day.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
                attendanceTrendLabels.push(label);
                attendanceTrendData.push(trendMap[key] || 0);
            });
        }

        // Calculate total students across all classes the teacher is class teacher of
        let totalMyStudents = myStudentCount;
        if (myClasses && myClasses.length > 1) {
            const allMyClassIds = myClasses.map(c => c._id);
            totalMyStudents = await User.countDocuments({ currentClass: { $in: allMyClassIds }, role: 'student' });
        }

        // 6. Performance Charts (Percentage-based performance per subject)
        let subjectPerformanceLabels = [];
        let subjectPerformanceData = [];

        // Query active subjects taught by this teacher in the active academic year
        const subjectFilter = { teachers: teacherId };
        if (yearId) {
            subjectFilter.academicYear = yearId;
        }

        let subjectsTaught = await Subject.find(subjectFilter)
            .populate('class', 'name section branch')
            .lean();

        // Fallback: If not found in Subject.teachers, check teacher's user.subjects
        if (!subjectsTaught || subjectsTaught.length === 0) {
            const teacherUser = await User.findById(teacherId).populate({
                path: 'subjects',
                populate: { path: 'class', select: 'name section branch' }
            }).lean();

            if (teacherUser && teacherUser.subjects && teacherUser.subjects.length > 0) {
                subjectsTaught = teacherUser.subjects.filter(s =>
                    s && (!yearId || !s.academicYear || s.academicYear.toString() === yearId.toString())
                );
                if (subjectsTaught.length === 0) {
                    subjectsTaught = teacherUser.subjects.filter(Boolean);
                }
            }
        }

        if (subjectsTaught && subjectsTaught.length > 0) {
            const subjectIds = subjectsTaught.map(s => s._id);

            const examMatch = {
                'examDetails.subject': { $in: subjectIds },
                'examDetails.totalMarks': { $gt: 0 }
            };
            if (yearId) {
                try {
                    examMatch['examDetails.academicYear'] = new mongoose.Types.ObjectId(yearId);
                } catch (_) {
                    examMatch['examDetails.academicYear'] = yearId;
                }
            }

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
                { $match: examMatch },
                {
                    $project: {
                        subject: '$examDetails.subject',
                        percentage: {
                            $multiply: [
                                { $divide: ['$marksObtained', '$examDetails.totalMarks'] },
                                100
                            ]
                        }
                    }
                },
                {
                    $group: {
                        _id: '$subject',
                        avgPercentage: { $avg: '$percentage' }
                    }
                }
            ]);

            // Track duplicate subject names across different classes
            const nameCountMap = {};
            subjectsTaught.forEach(sub => {
                const cleanName = sub.name ? sub.name.trim() : 'Subject';
                nameCountMap[cleanName] = (nameCountMap[cleanName] || 0) + 1;
            });

            // Map each taught subject to its percentage average with class disambiguation if needed
            subjectsTaught.forEach(sub => {
                const stat = marksStats.find(m => m._id.toString() === sub._id.toString());
                if (stat && stat.avgPercentage !== undefined && stat.avgPercentage !== null) {
                    const cleanName = sub.name ? sub.name.trim() : 'Subject';
                    let label = cleanName;
                    // If teacher teaches this subject across multiple classes, disambiguate with class label
                    if (nameCountMap[cleanName] > 1 && sub.class) {
                        const secStr = sub.class.section ? ` ${sub.class.section}` : '';
                        label = `${cleanName} (${sub.class.name}${secStr})`;
                    }
                    subjectPerformanceLabels.push(label);
                    subjectPerformanceData.push(Math.round(stat.avgPercentage));
                }
            });

        } else if (myClass) {
            // Fallback: Show class performance across subjects for class teacher's class
            const students = await User.find({ currentClass: myClass._id, role: 'student' }).select('_id');
            const studentIds = students.map(s => s._id);

            const fallbackExamMatch = {
                'examDetails.totalMarks': { $gt: 0 }
            };
            if (yearId) {
                try {
                    fallbackExamMatch['examDetails.academicYear'] = new mongoose.Types.ObjectId(yearId);
                } catch (_) {
                    fallbackExamMatch['examDetails.academicYear'] = yearId;
                }
            }

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
                { $match: fallbackExamMatch },
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
                    $project: {
                        subjectName: '$subjectDetails.name',
                        percentage: {
                            $multiply: [
                                { $divide: ['$marksObtained', '$examDetails.totalMarks'] },
                                100
                            ]
                        }
                    }
                },
                {
                    $group: {
                        _id: '$subjectName',
                        avgPercentage: { $avg: '$percentage' }
                    }
                },
                { $limit: 6 }
            ]);

            classStats.forEach(stat => {
                subjectPerformanceLabels.push(stat._id);
                subjectPerformanceData.push(Math.round(stat.avgPercentage));
            });
        }

        const responseData = {
            overview: {
                classesToday: classesTodayCount,
                totalClassesTaught: totalClassesTaught,
                myStudents: myStudentCount,
                totalMyStudents: totalMyStudents,
                lowAttendanceCount: lowAttendanceCount,
                className: className,
                classId: myClass ? myClass._id : null,
                classes: (myClasses || []).map(c => ({
                    _id: c._id,
                    name: c.name,
                    section: c.section,
                    className: `${c.name} ${c.section || ''}`.trim()
                })),
                selectedClassId: myClass ? myClass._id : null
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
            nextExam,
            latestRatingRecords,
            totalRatableSubjects,
            classRatingAgg
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
            // Previous month for trend (in IST)
            (() => {
                const { year: curY, month: curM } = getISTMonthYear();
                const prevY = curM === 1 ? curY - 1 : curY;
                const prevM = curM === 1 ? 12 : curM - 1;
                const { startOfMonth, endOfMonth } = getISTMonthBounds(prevY, prevM);
                return Attendance.countDocuments({
                    user: studentId,
                    role: 'student',
                    date: { $gte: startOfMonth, $lte: endOfMonth }
                });
            })(),
            (() => {
                const { year: curY, month: curM } = getISTMonthYear();
                const prevY = curM === 1 ? curY - 1 : curY;
                const prevM = curM === 1 ? 12 : curM - 1;
                const { startOfMonth, endOfMonth } = getISTMonthBounds(prevY, prevM);
                return Attendance.countDocuments({
                    user: studentId,
                    role: 'student',
                    status: 'present',
                    date: { $gte: startOfMonth, $lte: endOfMonth }
                });
            })(),
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
            (() => {
                const { startOfDay: todayStart } = getISTDayBounds();
                const query = {
                    $or: [
                        { date: { $gte: todayStart } },
                        { examDate: { $gte: todayStart } }
                    ],
                    ...(classId ? { class: classId } : {})
                };
                return Exam.findOne(query)
                    .sort({ date: 1, examDate: 1 })
                    .select('date examDate name standardizedType subject')
                    .populate('subject', 'name')
                    .lean();
            })(),
            // Holistic ratings for student in academic year
            StudentRating.find({
                student: studentId,
                ...(activeYear ? { academicYear: activeYear._id } : {})
            })
                .populate('subject', 'name ratingEnabled')
                .sort({ year: -1, month: -1 })
                .lean(),
            // Total ratable subjects for student's class
            classId
                ? Subject.countDocuments({
                    class: classId,
                    ...(activeYear ? { academicYear: activeYear._id } : {}),
                    ratingEnabled: { $ne: false }
                })
                : 0,
            // Class ratings aggregation for cumulative class benchmark & comparison
            classId
                ? StudentRating.aggregate([
                    {
                        $match: {
                            class: new mongoose.Types.ObjectId(classId),
                            ...(activeYear ? { academicYear: new mongoose.Types.ObjectId(activeYear._id) } : {}),
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
                ])
                : []
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

        // 4. Next Exam Date & Name
        const examDateVal = nextExam?.date || nextExam?.examDate;
        const nextExamDate = examDateVal
            ? getISTDateString(examDateVal)
            : null;
        const nextExamName = nextExam
            ? (nextExam.subject?.name || nextExam.name || nextExam.standardizedType || null)
            : null;

        // 5. Holistic Student Rating Summary (Cumulative + Class Comparison + Current Month Status)
        const validRatings = (latestRatingRecords || []).filter(
            r => !r.isExempt && r.averageScore != null && r.subject && r.subject.ratingEnabled !== false
        );

        // 5a. Cumulative Academic Year Rating
        let cumulativeAverage = null;
        const cumulativeCount = validRatings.length;
        if (cumulativeCount > 0) {
            cumulativeAverage = parseFloat(
                (validRatings.reduce((s, r) => s + r.averageScore, 0) / cumulativeCount).toFixed(1)
            );
        }
        const cumEval = StudentRating.getPerformanceEvaluation(cumulativeAverage);
        const cumEngagement = cumulativeCount > 0
            ? parseFloat((validRatings.reduce((s, r) => s + (r.classEngagement || 0), 0) / cumulativeCount).toFixed(1))
            : null;
        const cumHomework = cumulativeCount > 0
            ? parseFloat((validRatings.reduce((s, r) => s + (r.homeworkClasswork || 0), 0) / cumulativeCount).toFixed(1))
            : null;
        const cumBehaviour = cumulativeCount > 0
            ? parseFloat((validRatings.reduce((s, r) => s + (r.behaviourSocial || 0), 0) / cumulativeCount).toFixed(1))
            : null;
        const cumEnglish = cumulativeCount > 0
            ? parseFloat((validRatings.reduce((s, r) => s + (r.englishComm || 0), 0) / cumulativeCount).toFixed(1))
            : null;

        // 5b. Class Cumulative Benchmark & Peer Comparison
        let classComparison = null;
        if (classRatingAgg && classRatingAgg.length > 0) {
            const classSum = classRatingAgg.reduce((s, c) => s + c.studentAvg, 0);
            const classCumulativeAverage = parseFloat((classSum / classRatingAgg.length).toFixed(1));
            const studentIdx = classRatingAgg.findIndex(c => c._id.toString() === studentId.toString());
            const studentRank = studentIdx !== -1 ? studentIdx + 1 : null;
            const diff = cumulativeAverage != null
                ? parseFloat((cumulativeAverage - classCumulativeAverage).toFixed(1))
                : null;

            let standingLabel = 'On Par with Class';
            if (studentRank === 1) standingLabel = 'Top Performer';
            else if (diff != null && diff >= 0.4) standingLabel = 'Well Above Class Avg';
            else if (diff != null && diff > 0.0) standingLabel = 'Above Class Average';
            else if (diff != null && diff === 0.0) standingLabel = 'On Par with Class';
            else if (diff != null) standingLabel = 'Below Class Average';

            classComparison = {
                classCumulativeAverage,
                difference: diff,
                rank: studentRank,
                totalStudentsRated: classRatingAgg.length,
                standingLabel
            };
        }

        // 5c. Current Calendar Month Live Status & Provisional Rating
        const currentMY = getISTMonthYear();
        const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const curMonthRatings = validRatings.filter(r => r.month === currentMY.month && r.year === currentMY.year);
        const curRatedCount = curMonthRatings.length;
        const totalSubjectsCount = totalRatableSubjects || (curRatedCount > 0 ? curRatedCount : 0);
        let curStatus = 'not_started';
        if (totalSubjectsCount > 0 && curRatedCount >= totalSubjectsCount) {
            curStatus = 'completed';
        } else if (curRatedCount > 0) {
            curStatus = 'in_progress';
        }

        let provisionalAvg = null;
        if (curRatedCount > 0) {
            provisionalAvg = parseFloat(
                (curMonthRatings.reduce((s, r) => s + r.averageScore, 0) / curRatedCount).toFixed(1)
            );
        }
        const curEval = StudentRating.getPerformanceEvaluation(provisionalAvg);

        const currentMonth = {
            month: currentMY.month,
            year: currentMY.year,
            monthName: MONTH_NAMES[currentMY.month - 1],
            status: curStatus,
            isCurrentMonth: true,
            ratedCount: curRatedCount,
            totalSubjects: totalSubjectsCount,
            provisionalAverage: provisionalAvg,
            label: curEval.label,
            variant: curEval.variant
        };

        // 5d. Latest Month Fallback for Backwards Compatibility
        let topMonth = currentMY.month;
        let topYear = currentMY.year;
        let topAvg = provisionalAvg || cumulativeAverage;
        let topLabel = cumEval.label;
        let topVariant = cumEval.variant;
        let topRatings = curMonthRatings;

        if (validRatings.length > 0) {
            topMonth = validRatings[0].month;
            topYear = validRatings[0].year;
            topRatings = validRatings.filter(r => r.month === topMonth && r.year === topYear);
            if (topRatings.length > 0) {
                topAvg = parseFloat((topRatings.reduce((s, r) => s + r.averageScore, 0) / topRatings.length).toFixed(1));
                const e = StudentRating.getPerformanceEvaluation(topAvg);
                topLabel = e.label;
                topVariant = e.variant;
            }
        }

        let latestRatingSummary = null;
        if (cumulativeCount > 0 || curRatedCount > 0 || (classRatingAgg && classRatingAgg.length > 0)) {
            const displayAvg = cumulativeAverage ?? topAvg;
            const displayLabel = cumulativeAverage != null ? cumEval.label : topLabel;
            const displayVariant = cumulativeAverage != null ? cumEval.variant : topVariant;

            latestRatingSummary = {
                // Primary Holistic Cumulative Metrics
                cumulativeAverage,
                cumulativeCount,
                cumulativeLabel: cumEval.label,
                cumulativeVariant: cumEval.variant,

                // Class Peer Comparison
                classComparison,

                // Current Month Live Status & In-Progress Metrics
                currentMonth,

                // Backward compatibility properties for existing consumers
                averageScore: displayAvg,
                average: displayAvg,
                month: topMonth,
                year: topYear,
                label: displayLabel,
                variant: displayVariant,
                ratedSubjectCount: cumulativeCount || topRatings.length,
                ratedCount: cumulativeCount || topRatings.length,
                classEngagement: cumEngagement,
                homeworkClasswork: cumHomework,
                behaviourSocial: cumBehaviour,
                englishComm: cumEnglish,
                criteriaAverages: {
                    classEngagement: cumEngagement,
                    homeworkClasswork: cumHomework,
                    behaviourSocial: cumBehaviour,
                    englishComm: cumEnglish
                }
            };
        } else {
            // Friendly zero-state: evaluation active in current academic year
            latestRatingSummary = {
                cumulativeAverage: null,
                cumulativeCount: 0,
                cumulativeLabel: 'Not Rated',
                cumulativeVariant: 'neutral',
                classComparison,
                currentMonth,
                averageScore: null,
                average: null,
                month: currentMY.month,
                year: currentMY.year,
                label: 'Not Rated',
                variant: 'neutral',
                ratedSubjectCount: 0,
                ratedCount: 0,
                criteriaAverages: null
            };
        }

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
                nextExamName,
                rating: latestRatingSummary
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
 * Invalidate admin dashboard caches only
 */
exports.invalidateAdminDashboard = async () => {
    adminStatsCache.clear();
    try {
        await cacheInvalidatePattern('adminStats:*');
    } catch (_) {}
};

/**
 * Invalidate specific teacher dashboard cache
 */
exports.invalidateTeacherDashboard = async (teacherId) => {
    if (!teacherId) return;
    const idStr = teacherId.toString();
    teacherStatsCache.deletePrefix(`teacherStats:${idStr}:`);
    try {
        await cacheInvalidatePattern(`teacherStats:${idStr}:*`);
    } catch (_) {}
};

/**
 * Invalidate specific student dashboard cache
 */
exports.invalidateStudentDashboard = async (studentId) => {
    if (!studentId) return;
    const idStr = studentId.toString();
    studentStatsCache.deletePrefix(`studentStats:${idStr}:`);
    try {
        await cacheInvalidatePattern(`studentStats:${idStr}:*`);
    } catch (_) {}
};

/**
 * Invalidate dashboards for multiple students (e.g. for class attendance or marks updates)
 */
exports.invalidateMultipleStudentDashboards = async (studentIds) => {
    if (!studentIds || !Array.isArray(studentIds) || studentIds.length === 0) return;
    const promises = [];
    for (const studentId of studentIds) {
        if (!studentId) continue;
        const idStr = studentId.toString();
        studentStatsCache.deletePrefix(`studentStats:${idStr}:`);
        promises.push(cacheInvalidatePattern(`studentStats:${idStr}:*`));
    }
    try {
        await Promise.all(promises);
    } catch (_) {}
};
