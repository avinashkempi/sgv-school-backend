const User = require('../models/User');
const Attendance = require('../models/Attendance');
const FeePayment = require('../models/FeePayment');
const StudentFee = require('../models/StudentFee');
const Complaint = require('../models/Complaint');
const Marks = require('../models/Marks');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const Exam = require('../models/Exam');
const AcademicYear = require('../models/AcademicYear');

// Helper to calculate date range
const getDateRange = (range) => {
    const now = new Date();
    let startDate, endDate = now;

    switch (range) {
        case 'today':
            startDate = new Date(now);
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(now);
            endDate.setHours(23, 59, 59, 999);
            break;
        case 'thisWeek':
            const startOfWeek = now.getDate() - now.getDay();
            startDate = new Date(now.setDate(startOfWeek));
            startDate.setHours(0, 0, 0, 0);
            break;
        case 'last30Days':
            startDate = new Date(now);
            startDate.setDate(startDate.getDate() - 30);
            break;
        case 'thisYear':
            startDate = new Date(now.getFullYear(), 0, 1);
            break;
        case 'lastYear':
            startDate = new Date(now.getFullYear() - 1, 0, 1);
            endDate = new Date(now.getFullYear() - 1, 11, 31);
            break;
        case 'allTime':
            startDate = new Date(2020, 0, 1); // Or your school's founding date
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

        // Parallel Execution - query both StudentFee.payments (imported) and FeePayment (app-recorded)
        const [
            totalStudents,
            totalTeachers,
            attendanceToday,
            importedFees,
            appFees,
            prevImportedFees,
            prevAppFees,
            prevAttendance,
            recentComplaints
        ] = await Promise.all([
            User.countDocuments({ role: 'student' }),
            User.countDocuments({ role: 'teacher' }),
            Attendance.find({
                date: { $gte: today, $lt: tomorrow },
                role: 'student'
            }).lean(),
            // Imported fees (StudentFee.payments)
            StudentFee.aggregate([
                { $unwind: "$payments" },
                { $match: { "payments.date": { $gte: startDate, $lte: endDate } } },
                { $group: { _id: null, total: { $sum: "$payments.amount" } } }
            ]),
            // App-recorded fees (FeePayment)
            FeePayment.aggregate([
                { $match: { status: 'success', paymentDate: { $gte: startDate, $lte: endDate } } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            // Previous period imported fees
            StudentFee.aggregate([
                { $unwind: "$payments" },
                { $match: { "payments.date": { $gte: prevStartDate, $lt: prevEndDate } } },
                { $group: { _id: null, total: { $sum: "$payments.amount" } } }
            ]),
            // Previous period app-recorded fees
            FeePayment.aggregate([
                { $match: { status: 'success', paymentDate: { $gte: prevStartDate, $lt: prevEndDate } } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            Attendance.find({
                date: { $gte: prevStartDate, $lt: prevEndDate },
                role: 'student'
            }).lean(),
            Complaint.find()
                .sort({ createdAt: -1 })
                .limit(5)
                .populate('student', 'name')
                .select('title status student createdAt')
                .lean()
        ]);

        const presentCount = attendanceToday.filter(a => a.status === 'present').length;
        const absentCount = attendanceToday.filter(a => a.status === 'absent').length;
        const attendancePercentage = attendanceToday.length > 0
            ? ((presentCount / attendanceToday.length) * 100).toFixed(1)
            : 0;

        // Calculate attendance trend
        const prevPresentCount = prevAttendance.filter(a => a.status === 'present').length;
        const prevAttendancePercentage = prevAttendance.length > 0
            ? ((prevPresentCount / prevAttendance.length) * 100)
            : 0;
        const attendanceTrend = (attendancePercentage - prevAttendancePercentage).toFixed(1);

        // Combine imported + app-recorded fees
        const totalCollected = (importedFees[0]?.total || 0) + (appFees[0]?.total || 0);
        const prevTotalCollected = (prevImportedFees[0]?.total || 0) + (prevAppFees[0]?.total || 0);
        const feeCollectionTrend = prevTotalCollected > 0
            ? (((totalCollected - prevTotalCollected) / prevTotalCollected) * 100).toFixed(1)
            : 0;

        // Fee Trend Logic - show all months of academic year
        const activeYear = await AcademicYear.findOne({ isActive: true }).lean();
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
                    { $match: { status: 'success', paymentDate: { $gte: ayStart, $lte: ayEnd } } },
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

        res.json({
            overview: {
                totalStudents,
                totalTeachers,
                attendancePercentage: parseFloat(attendancePercentage),
                attendanceTrend: parseFloat(attendanceTrend),
                totalCollected,
                feeCollectionTrend: parseFloat(feeCollectionTrend)
            },
            charts: {
                attendance: { present: presentCount, absent: absentCount },
                feeTrend
            },
            recentComplaints
        });

    } catch (error) {
        console.error('Admin Dashboard Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// Teacher Stats
exports.getTeacherStats = async (req, res) => {
    try {
        const teacherId = req.user.id;
        const todayPrice = new Date();
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const currentDay = days[todayPrice.getDay()];

        // 1. Classes Today
        const timetables = await require('../models/Timetable').find({
            "schedule.day": currentDay,
            "schedule.periods.teacher": teacherId
        }).lean();

        let classesTodayCount = 0;
        timetables.forEach(tt => {
            const daySchedule = tt.schedule.find(s => s.day === currentDay);
            if (daySchedule) {
                classesTodayCount += daySchedule.periods.filter(p => p.teacher && p.teacher.toString() === teacherId).length;
            }
        });

        // 2. Low Attendance Students (< 75% attendance) & My Students Context
        // Strategy: Check if teacher is a Class Teacher first
        const myClass = await Class.findOne({ classTeacher: teacherId });
        let lowAttendanceCount = 0;
        let attendanceWaitData = [];

        if (myClass) {
            // Get students of this class
            const students = await User.find({ currentClass: myClass._id, role: 'student' }).select('_id').lean();
            const studentIds = students.map(s => s._id);

            // Calculate attendance for last 30 days
            const { startDate, endDate } = getDateRange('last30Days');

            const attendanceStats = await Attendance.aggregate([
                {
                    $match: {
                        user: { $in: studentIds },
                        date: { $gte: startDate, $lte: endDate },
                        role: 'student'
                    }
                },
                {
                    $group: {
                        _id: "$user",
                        total: { $sum: 1 },
                        present: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } }
                    }
                }
            ]);

            // Count students with < 75% attendance
            lowAttendanceCount = attendanceStats.filter(stat => {
                const pct = stat.total > 0 ? (stat.present / stat.total) * 100 : 0;
                return pct < 75;
            }).length;

            // Calculate Weekly Attendance Trend (Last 4 weeks or days?)
            // Let's do last 4 days for the chart "attendanceWait" (Wait?? Maybe "Rate"?)
            // Keeping key "attendanceWait" to match frontend expectation if any, but mapping it to last 4 days presence %
            // Actually, let's just send some real trend data.
            const last4DaysStats = await Attendance.aggregate([
                {
                    $match: {
                        user: { $in: studentIds },
                        date: { $gte: new Date(new Date().setDate(new Date().getDate() - 4)) },
                        role: 'student'
                    }
                },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                        presentCount: { $sum: { $cond: [{ $eq: ["$status", "present"] }, 1, 0] } },
                        totalCount: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            attendanceWaitData = last4DaysStats.map(s =>
                s.totalCount > 0 ? Math.round((s.presentCount / s.totalCount) * 100) : 0
            );
        }

        // 3. Performance Charts (Avg Marks per Subject via Exams)
        // Find exams for subjects this teacher teaches (or all exams if we can't filter easily)
        // Better: Find marks for students in myClass (if exists) or generally all marks (too big).
        // Let's filter by Teacher's Subjects if available in User model
        const teacherUser = await User.findById(teacherId).populate('subjects');
        let subjectPerformanceLabels = [];
        let subjectPerformanceData = [];

        if (teacherUser && teacherUser.subjects && teacherUser.subjects.length > 0) {
            const subjectIds = teacherUser.subjects.map(s => s._id);
            const subjectNames = teacherUser.subjects.map(s => s.name); // Using simple map, assuming populated

            // Aggregation: Average marks per subject for recent exams
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
                        avgMarks: { $avg: '$marksObtained' } // Assuming max marks vary, this is raw avg. Ideally percentage.
                        // To get percentage, we need maxMarks from Exam. 
                        // Let's assume marksObtained is what we want for now or try to project percentage
                    }
                }
            ]);

            // Map results to labels
            // We need to map back ID to Name. 
            // marksStats: [{ _id: SubjectID, avgMarks: 75 }]
            // We can iterate teacherUser.subjects

            teacherUser.subjects.forEach(sub => {
                const stat = marksStats.find(m => m._id.toString() === sub._id.toString());
                if (stat) {
                    subjectPerformanceLabels.push(sub.name.substring(0, 10));
                    subjectPerformanceData.push(Math.round(stat.avgMarks));
                }
            });

        } else {
            // Fallback if no specific subjects assigned, maybe show Class performance if Class Teacher?
            if (myClass) {
                // Show avg performance of my class across all subjects
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
        }


        res.json({
            // message: "Real teacher stats",
            overview: {
                classesToday: classesTodayCount,
                // pendingHomework: 0, // Removed
                lowAttendanceCount: lowAttendanceCount
            },
            charts: {
                performance: {
                    labels: subjectPerformanceLabels.length > 0 ? subjectPerformanceLabels : ['No Data'],
                    data: subjectPerformanceData.length > 0 ? subjectPerformanceData : [0]
                },
                attendanceWait: attendanceWaitData.length > 0 ? attendanceWaitData : [0, 0, 0, 0] // Weekly trend
            }
        });

    } catch (error) {
        console.error('Teacher Stats Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// Student Stats
exports.getStudentStats = async (req, res) => {
    try {
        const studentId = req.user.id;

        const activeYear = await AcademicYear.findOne({ isActive: true }).lean();

        // Get student info (class)
        const student = await User.findById(studentId).select('currentClass').lean();
        const classId = student?.currentClass;

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
            // Recent marks for performance chart
            Marks.find({ student: studentId })
                .sort({ createdAt: -1 })
                .limit(10)
                .populate({
                    path: 'exam',
                    select: 'name',
                    populate: { path: 'subject', select: 'name' }
                })
                .lean(),
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

        // 2. Fee Due - use pendingAmount from StudentFee (CSV source of truth)
        //    Subtract any additional app-recorded payments on top
        const csvPending = studentFeeRecord?.pendingAmount || 0;
        const appPaid = appPayments[0]?.total || 0;
        // Only subtract appPaid if it's not already reflected in pendingAmount
        // pendingAmount from CSV = totalFees - totalPaid (at import time)
        // appPaid = payments made via app after import
        const dueAmount = Math.max(csvPending - appPaid, 0);

        // 3. Performance trend
        const performanceTrend = recentMarks.map(m => ({
            exam: m.exam?.name || 'Unknown',
            subject: m.exam?.subject?.name || 'Subject',
            marks: m.marksObtained,
            date: m.createdAt
        })).reverse();

        // 4. Next Exam Date
        const nextExamDate = nextExam
            ? new Date(nextExam.examDate).toISOString().split('T')[0]
            : null;

        res.json({
            overview: {
                attendancePercentage: parseFloat(attendancePercentage),
                attendanceTrend: parseFloat(attendanceTrend),
                dueAmount,
                totalFees: studentFeeRecord?.totalFees || 0,
                totalPaid: studentFeeRecord?.totalPaid || 0,
                nextExamDate,
                nextExamName: nextExam?.name || null
            },
            charts: {
                performanceTrend
            }
        });

    } catch (error) {
        console.error('Student Dashboard Error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};
