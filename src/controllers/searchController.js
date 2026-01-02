const User = require('../models/User');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const Exam = require('../models/Exam');
const Complaint = require('../models/Complaint');
const Event = require('../models/Event');
const FeePayment = require('../models/FeePayment');
const Attendance = require('../models/Attendance');

// Global search across multiple entities
exports.globalSearch = async (req, res) => {
    try {
        const { q, entities = 'all', limit = 10 } = req.query;

        if (!q || q.trim().length < 2) {
            return res.status(400).json({ message: 'Search query must be at least 2 characters' });
        }

        const searchRegex = new RegExp(q, 'i');
        const results = {};

        // Determine which entities to search
        const searchEntities = entities === 'all'
            ? ['users', 'classes', 'subjects', 'exams', 'complaints', 'events']
            : entities.split(',');

        // Search Users (students, teachers, staff)
        if (searchEntities.includes('users')) {
            results.users = await User.find({
                $or: [
                    { name: searchRegex },
                    { email: searchRegex },
                    { phone: searchRegex }
                ]
            })
                .select('name email phone role')
                .limit(parseInt(limit))
                .lean();
        }

        // Search Classes
        if (searchEntities.includes('classes')) {
            results.classes = await Class.find({
                $or: [
                    { name: searchRegex },
                    { section: searchRegex }
                ]
            })
                .populate('classTeacher', 'name')
                .limit(parseInt(limit))
                .lean();
        }

        // Search Subjects
        if (searchEntities.includes('subjects')) {
            results.subjects = await Subject.find({
                name: searchRegex
            })
                .populate('class', 'name section')
                .limit(parseInt(limit))
                .lean();
        }

        // Search Exams
        if (searchEntities.includes('exams')) {
            results.exams = await Exam.find({
                name: searchRegex
            })
                .populate('class', 'name section')
                .populate('subject', 'name')
                .limit(parseInt(limit))
                .lean();
        }

        // Search Complaints
        if (searchEntities.includes('complaints')) {
            results.complaints = await Complaint.find({
                $or: [
                    { title: searchRegex },
                    { description: searchRegex }
                ]
            })
                .populate('student', 'name')
                .limit(parseInt(limit))
                .lean();
        }

        // Search Events
        if (searchEntities.includes('events')) {
            results.events = await Event.find({
                $or: [
                    { title: searchRegex },
                    { description: searchRegex }
                ]
            })
                .limit(parseInt(limit))
                .lean();
        }

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

        // Text search
        if (search) {
            const searchRegex = new RegExp(search, 'i');
            query.$or = [
                { name: searchRegex },
                { email: searchRegex },
                { phone: searchRegex }
            ];
        }

        let students = await User.find(query)
            .populate('class', 'name section')
            .sort({ [sortBy]: order === 'asc' ? 1 : -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit))
            .lean();

        // Filter by class/section if specified
        if (className || section) {
            const classQuery = {};
            if (className) classQuery.name = className;
            if (section) classQuery.section = section;

            const matchingClasses = await Class.find(classQuery).select('_id').lean();
            const classIds = matchingClasses.map(c => c._id.toString());

            students = students.filter(s => s.class && classIds.includes(s.class._id.toString()));
        }

        // Calculate attendance for each student (if filtering by attendance)
        if (minAttendance || maxAttendance) {
            const studentsWithAttendance = await Promise.all(
                students.map(async (student) => {
                    const totalDays = await Attendance.countDocuments({
                        user: student._id,
                        role: 'student'
                    });
                    const presentDays = await Attendance.countDocuments({
                        user: student._id,
                        role: 'student',
                        status: 'present'
                    });

                    const attendancePercentage = totalDays > 0
                        ? (presentDays / totalDays) * 100
                        : 0;

                    return { ...student, attendancePercentage };
                })
            );

            students = studentsWithAttendance.filter(s => {
                if (minAttendance && s.attendancePercentage < parseFloat(minAttendance)) return false;
                if (maxAttendance && s.attendancePercentage > parseFloat(maxAttendance)) return false;
                return true;
            });
        }

        // Filter by fee status if specified
        if (feeStatus && feeStatus !== 'all') {
            const studentsWithFees = await Promise.all(
                students.map(async (student) => {
                    const pendingFees = await FeePayment.countDocuments({
                        student: student._id,
                        status: 'pending'
                    });
                    return { ...student, hasPendingFees: pendingFees > 0 };
                })
            );

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
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
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

        let exams = await Exam.find(query)
            .populate('class', 'name section')
            .populate('subject', 'name')
            .sort({ [sortBy]: order === 'asc' ? 1 : -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit))
            .lean();

        // Filter by class/section/subject
        exams = exams.filter(exam => {
            if (className && exam.class?.name !== className) return false;
            if (section && exam.class?.section !== section) return false;
            if (subject && exam.subject?.name !== subject) return false;
            return true;
        });

        const total = await Exam.countDocuments(query);

        res.json({
            data: exams,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
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

        const complaints = await Complaint.find(query)
            .populate('student', 'name email')
            .populate('assignedTo', 'name')
            .sort({ [sortBy]: order === 'asc' ? 1 : -1 })
            .skip((page - 1) * limit)
            .limit(parseInt(limit))
            .lean();

        const total = await Complaint.countDocuments(query);

        res.json({
            data: complaints,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('Filter Complaints Error:', error);
        res.status(500).json({ message: 'Filter failed', error: error.message });
    }
};
