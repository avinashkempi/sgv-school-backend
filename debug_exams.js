const mongoose = require('mongoose');
const Exam = require('./src/models/Exam');
const AcademicYear = require('./src/models/AcademicYear');
const Class = require('./src/models/Class');
const Subject = require('./src/models/Subject');
const Marks = require('./src/models/Marks');
const User = require('./src/models/User');

require('dotenv').config();

async function check() {
    try {
        const uri = process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGODB_URI not found in .env');
        await mongoose.connect(uri);

        const activeYear = await AcademicYear.findOne({ isActive: true }).lean();
        const yearId = activeYear._id;

        const exams = await Exam.find({ academicYear: yearId, isStandardized: true })
            .populate('class', 'name section')
            .populate('subject', 'name')
            .lean();

        console.log(`Found ${exams.length} exams for marks-status in year ${yearId}`);

        if (exams.length === 0) return console.log('Empty exams array');

        // Sort in memory instead
        exams.sort((a, b) => {
            const classA = a.class ? `${a.class.name} ${a.class.section || ''}` : '';
            const classB = b.class ? `${b.class.name} ${b.class.section || ''}` : '';
            if (classA !== classB) return classA.localeCompare(classB);
            const typeOrder = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];
            return typeOrder.indexOf(a.standardizedType) - typeOrder.indexOf(b.standardizedType);
        });

        const classIds = [...new Set(exams.map(e => e.class?._id))].filter(Boolean);
        const studentCounts = await User.aggregate([
            { $match: { role: 'student', currentClass: { $in: classIds } } },
            { $group: { _id: '$currentClass', count: { $sum: 1 } } }
        ]);
        const studentCountMap = {};
        studentCounts.forEach(item => { studentCountMap[item._id.toString()] = item.count; });

        const examIds = exams.map(e => e._id);
        const marksCounts = await Marks.aggregate([
            { $match: { exam: { $in: examIds } } },
            { $group: { _id: '$exam', count: { $sum: 1 } } }
        ]);
        const marksCountMap = {};
        marksCounts.forEach(item => { marksCountMap[item._id.toString()] = item.count; });

        const statusReport = exams.map(exam => {
            const classId = exam.class?._id?.toString();
            const examId = exam._id.toString();
            const totalStudents = studentCountMap[classId] || 0;
            const enteredMarksCount = marksCountMap[examId] || 0;
            return {
                _id: exam._id, examName: exam.name, examType: exam.standardizedType,
                className: exam.class ? `${exam.class.name} ${exam.class.section || ''}` : 'Unknown',
                subjectName: exam.subject?.name || 'Unknown', date: exam.date,
                totalStudents, enteredMarksCount,
                status: enteredMarksCount === 0 ? 'Pending' : (enteredMarksCount >= totalStudents ? 'Complete' : 'Partial')
            };
        });
        
        console.log("FINAL OUTPUT:");
        console.log(JSON.stringify(statusReport, null, 2));

        process.exit(0);
    } catch (err) {
        console.error('SERVER ERROR:', err);
        process.exit(1);
    }
}

check();
