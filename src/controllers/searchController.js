const User = require('../models/User');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const Exam = require('../models/Exam');
const Complaint = require('../models/Complaint');
const Event = require('../models/Event');
const FeePayment = require('../models/FeePayment');
const Attendance = require('../models/Attendance');

// Global search across multiple entities (executed in parallel via Promise.all)
exports.globalSearch = async (req, res) => {
    try {
        const { q, entities = 'all', limit = 10 } = req.query;

        if (!q || q.trim().length < 2) {
            return res.status(400).json({ message: 'Search query must be at least 2 characters' });
        }

        const searchRegex = new RegExp(q, 'i');
        const results = {};
        const parsedLimit = parseInt(limit) || 10;

        // Determine which entities to search
        const searchEntities = entities === 'all'
            ? ['users', 'classes', 'subjects', 'exams', 'complaints', 'events']
            : entities.split(',');

        const searchTasks = [];

        // Search Users (students, teachers, staff)
        if (searchEntities.includes('users')) {
            searchTasks.push(
                User.find({
                    $or: [
                        { name: searchRegex },
                        { email: searchRegex },
                        { phone: searchRegex }
                    ]
                })
                    .select('name email phone role currentClass profilePhoto')
                    .populate('currentClass', 'name section')
                    .limit(parsedLimit)
                    .lean()
                    .then(docs => { results.users = docs; })
            );
        }

        // Search Classes
        if (searchEntities.includes('classes')) {
            searchTasks.push(
                Class.find({
                    $or: [
                        { name: searchRegex },
                        { section: searchRegex }
                    ]
                })
                    .populate('classTeacher', 'name')
                    .limit(parsedLimit)
                    .lean()
                    .then(docs => { results.classes = docs; })
            );
        }

        // Search Subjects
        if (searchEntities.includes('subjects')) {
            searchTasks.push(
                Subject.find({
                    name: searchRegex
                })
                    .populate('class', 'name section')
                    .limit(parsedLimit)
                    .lean()
                    .then(docs => { results.subjects = docs; })
            );
        }

        // Search Exams
        if (searchEntities.includes('exams')) {
            searchTasks.push(
                Exam.find({
                    name: searchRegex
                })
                    .populate('class', 'name section')
                    .populate('subject', 'name')
                    .limit(parsedLimit)
                    .lean()
                    .then(docs => { results.exams = docs; })
            );
        }

        // Search Complaints
        if (searchEntities.includes('complaints')) {
            searchTasks.push(
                Complaint.find({
                    $or: [
                        { title: searchRegex },
                        { description: searchRegex }
                    ]
                })
                    .populate('student', 'name')
                    .limit(parsedLimit)
                    .lean()
                    .then(docs => { results.complaints = docs; })
            );
        }

        // Search Events
        if (searchEntities.includes('events')) {
            searchTasks.push(
                Event.find({
                    $or: [
                        { title: searchRegex },
                        { description: searchRegex }
                    ]
                })
                    .limit(parsedLimit)
                    .lean()
                    .then(docs => { results.events = docs; })
            );
        }

        // Execute all queries in parallel
        await Promise.all(searchTasks);

        // Calculate total results
        const totalResults = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);

        res.json({
            query: q,
            totalResults,
            results
        });

    } catch (error) {
        console.error('Global Search Error:', error);
        res.status(500).json({ message: 'Search failed', error: error.message });
    }
};

// Advanced filter for students
exports.filterStudents = async (req, res) => {
    try {
        const {
            class: className,
            section,
            minAttendance,
            maxAttendance,
            feeStatus, // 'paid', 'pending', 'all'
            search,
            sortBy = 'name',
            order = 'asc',
            page = 1,
            limit = 20
        } = req.query;

        const query = { role: 'student' };

        // Filter by class/section if specified (in MongoDB query level)
        if (className || section) {
            const classQuery = {};
            if (className) classQuery.name = className;
            if (section) classQuery.section = section;

            const matchingClasses = await Class.find(classQuery).select('_id').lean();
            const classIds = matchingClasses.map(c => c._id);
            query.currentClass = { $in: classIds };
        }

        // Text search
        if (search) {
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { name: searchRegex },
                { email: searchRegex },
                { phone: searchRegex }
            ];
        }

        const parsedPage = parseInt(page) || 1;
        const parsedLimit = parseInt(limit) || 20;

        let students = await User.find(query)
            .populate('currentClass', 'name section')
            .sort({ [sortBy]: order === 'asc' ? 1 : -1 })
            .skip((parsedPage - 1) * parsedLimit)
            .limit(parsedLimit)
            .lean();

        // Calculate attendance for each student (if filtering by attendance)
        if (minAttendance || maxAttendance) {
            const studentIds = students.map(s => s._id);

            const attendanceAgg = await Attendance.aggregate([
                { $match: { user: { $in: studentIds }, role: 'student' } },
                {
                    $group: {
                        _id: '$user',
                        totalDays: { $sum: 1 },
                        presentDays: {
                            $sum: { $cond: [{ $in: ['$status', ['present', 'late', 'excused']] }, 1, 0] }
                        }
                    }
                }
            ]);

            const attendanceMap = new Map();
            attendanceAgg.forEach(a => {
                attendanceMap.set(a._id.toString(), a.totalDays > 0 ? (a.presentDays / a.totalDays) * 100 : 0);
            });

            const studentsWithAttendance = students.map(student => {
                const percentage = attendanceMap.get(student._id.toString()) || 0;
                return { ...student, attendancePercentage: percentage };
            });

            students = studentsWithAttendance.filter(s => {
                if (minAttendance && s.attendancePercentage < parseFloat(minAttendance)) return false;
                if (maxAttendance && s.attendancePercentage > parseFloat(maxAttendance)) return false;
                return true;
            });
        }

        // Filter by fee status if specified
        if (feeStatus && feeStatus !== 'all') {
            const studentIds = students.map(s => s._id);

            const pendingFeesAgg = await FeePayment.aggregate([
                { $match: { student: { $in: studentIds }, status: 'pending' } },
                { $group: { _id: '$student', count: { $sum: 1 } } }
            ]);

            const pendingFeesMap = new Set(pendingFeesAgg.map(f => f._id.toString()));

            const studentsWithFees = students.map(student => ({
                ...student,
                hasPendingFees: pendingFeesMap.has(student._id.toString())
            }));

            students = studentsWithFees.filter(s => {
                if (feeStatus === 'pending') return s.hasPendingFees;
                if (feeStatus === 'paid') return !s.hasPendingFees;
                return true;
            });
        }

        const total = await User.countDocuments(query);

        res.json({
            data: students,
            pagination: {
                total,
                page: parsedPage,
                limit: parsedLimit,
                pages: Math.ceil(total / parsedLimit)
            }
        });

    } catch (error) {
        console.error('Filter Students Error:', error);
        res.status(500).json({ message: 'Filter failed', error: error.message });
    }
};

// Advanced filter for exams
exports.filterExams = async (req, res) => {
    try {
        const {
            class: className,
            section,
            subject,
            startDate,
            endDate,
            search,
            sortBy = 'examDate',
            order = 'desc',
            page = 1,
            limit = 20
        } = req.query;

        const query = {};

        // Class / Section filter
        if (className || section) {
            const classQuery = {};
            if (className) classQuery.name = className;
            if (section) classQuery.section = section;
            const matchingClasses = await Class.find(classQuery).select('_id').lean();
            query.class = { $in: matchingClasses.map(c => c._id) };
        }

        // Subject filter
        if (subject) {
            const matchingSubjects = await Subject.find({ name: new RegExp(subject, 'i') }).select('_id').lean();
            query.subject = { $in: matchingSubjects.map(s => s._id) };
        }

        // Text search
        if (search) {
            query.name = new RegExp(search, 'i');
        }

        // Date range filter
        if (startDate || endDate) {
            query.examDate = {};
            if (startDate) query.examDate.$gte = new Date(startDate);
            if (endDate) query.examDate.$lte = new Date(endDate);
        }

        const parsedPage = parseInt(page) || 1;
        const parsedLimit = parseInt(limit) || 20;

        const [exams, total] = await Promise.all([
            Exam.find(query)
                .populate('class', 'name section')
                .populate('subject', 'name')
                .sort({ [sortBy]: order === 'asc' ? 1 : -1 })
                .skip((parsedPage - 1) * parsedLimit)
                .limit(parsedLimit)
                .lean(),
            Exam.countDocuments(query)
        ]);

        res.json({
            data: exams,
            pagination: {
                total,
                page: parsedPage,
                limit: parsedLimit,
                pages: Math.ceil(total / parsedLimit)
            }
        });

    } catch (error) {
        console.error('Filter Exams Error:', error);
        res.status(500).json({ message: 'Filter failed', error: error.message });
    }
};

// Advanced filter for complaints
exports.filterComplaints = async (req, res) => {
    try {
        const {
            status, // 'pending', 'resolved', 'in-progress'
            visibility, // 'public', 'private' 
            startDate,
            endDate,
            search,
            sortBy = 'createdAt',
            order = 'desc',
            page = 1,
            limit = 20
        } = req.query;

        const query = {};

        // Status filter
        if (status && status !== 'all') {
            query.status = status;
        }

        // Visibility filter
        if (visibility && visibility !== 'all') {
            query.visibility = visibility;
        }

        // Text search
        if (search) {
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { title: searchRegex },
                { description: searchRegex }
            ];
        }

        // Date range filter
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(startDate);
            if (endDate) query.createdAt.$lte = new Date(endDate);
        }

        const parsedPage = parseInt(page) || 1;
        const parsedLimit = parseInt(limit) || 20;

        const [complaints, total] = await Promise.all([
            Complaint.find(query)
                .populate('student', 'name email')
                .populate('assignedTo', 'name')
                .sort({ [sortBy]: order === 'asc' ? 1 : -1 })
                .skip((parsedPage - 1) * parsedLimit)
                .limit(parsedLimit)
                .lean(),
            Complaint.countDocuments(query)
        ]);

        res.json({
            data: complaints,
            pagination: {
                total,
                page: parsedPage,
                limit: parsedLimit,
                pages: Math.ceil(total / parsedLimit)
            }
        });

    } catch (error) {
        console.error('Filter Complaints Error:', error);
        res.status(500).json({ message: 'Filter failed', error: error.message });
    }
};
