const AcademicYear = require('../models/AcademicYear');
const StudentHistory = require('../models/StudentHistory');
const User = require('../models/User');
const Class = require('../models/Class');
const Attendance = require('../models/Attendance');
const Exam = require('../models/Exam');
const Marks = require('../models/Marks');
const LeaveRequest = require('../models/LeaveRequest');

exports.createYear = async (req, res) => {
    const { name, startDate, endDate, isActive } = req.body;

    try {
        let year = await AcademicYear.findOne({ name });
        if (year) {
            return res.status(400).json({ msg: 'Academic year already exists' });
        }

        year = new AcademicYear({
            name,
            startDate,
            endDate,
            isActive
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

exports.incrementYear = async (req, res) => {
    const { nextYearId } = req.body;

    try {
        const nextYear = await AcademicYear.findById(nextYearId);
        if (!nextYear) {
            return res.status(404).json({ msg: 'Next academic year not found' });
        }

        const currentYear = await AcademicYear.findOne({ isActive: true });
        if (!currentYear) {
            // If no active year, just activate the next one
            nextYear.isActive = true;
            await nextYear.save();
            return res.json({ msg: `Academic year activated: ${nextYear.name}` });
        }

        // 1. Create StudentHistory for all current students
        const students = await User.find({ role: 'student', academicYear: currentYear._id })
            .populate('currentClass');

        const historyRecords = students.map(student => ({
            student: student._id,
            class: student.currentClass ? student.currentClass._id : null,
            academicYear: currentYear._id,
            result: 'Promoted', // Default to Promoted, can be updated later
            finalGrade: '' // To be filled if available
        })).filter(record => record.class !== null); // Only record if they were in a class

        if (historyRecords.length > 0) {
            await StudentHistory.insertMany(historyRecords);
        }

        // 2. Promote Students (Linear Promotion Logic)
        // This is complex. We need to know the "next" class.
        // Assumption: Classes are named "1", "2", "3" or "Class 1", "Class 2".
        // Or we just unassign them and let Admin re-assign?
        // The prompt says: "Students will be promoted (teachers will be able to add/delete students)"
        // "Once academic year changes, every classes will be reset, students will be promoted"
        // Let's implement a simple promotion:
        // If Class Name is number, increment. If not, unassign.

        for (const student of students) {
            if (student.currentClass) {
                const currentClassName = student.currentClass.name;
                // Try to find next class
                // Regex to find number in class name
                const match = currentClassName.match(/(\d+)/);
                if (match) {
                    const currentNum = parseInt(match[0]);
                    const nextNum = currentNum + 1;
                    const nextClassNameRegex = new RegExp(`${nextNum}`);

                    // Find a class with the next number and same branch/section if possible
                    // This is a heuristic.
                    const nextClass = await Class.findOne({
                        name: { $regex: nextClassNameRegex },
                        branch: student.currentClass.branch
                        // section: student.currentClass.section // Section might change or merge
                    });

                    if (nextClass) {
                        student.currentClass = nextClass._id;
                    } else {
                        student.currentClass = null; // Graduated or no next class found
                    }
                } else {
                    student.currentClass = null; // Non-numeric class name
                }
            }

            student.academicYear = nextYear._id; // Move to next year
            await student.save();
        }

        // 3. Activate Next Year
        nextYear.isActive = true;
        await nextYear.save();
        // Pre-save hook will deactivate currentYear

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

        // 1. Parallel Fetching: History, Exams, Leaves, Attendance
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

        // Group by class
        const classWiseStudents = history.reduce((acc, curr) => {
            const className = curr.class ? `${curr.class.name} ${curr.class.section || ''}` : 'Unassigned';
            if (!acc[className]) acc[className] = [];
            acc[className].push(curr.student);
            return acc;
        }, {});

        // 2. Fetch Marks using exam IDs
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
