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
        console.log('Connected to MongoDB');

        const activeYear = await AcademicYear.findOne({ isActive: true }).lean();
        console.log('Active Academic Year:', activeYear ? `${activeYear.name} (${activeYear._id})` : 'NONE');

        if (activeYear) {
            const examsInYear = await Exam.countDocuments({ academicYear: activeYear._id });
            console.log('Exams in Active Year:', examsInYear);

            const standardizedInYear = await Exam.countDocuments({ 
                academicYear: activeYear._id, 
                isStandardized: true 
            });
            console.log('Standardized Exams in Active Year:', standardizedInYear);

            const examsWithReportType = await Exam.find({ academicYear: activeYear._id, standardizedType: { $exists: true } }).limit(5).populate('class subject').lean();
            console.log('Sample Exams with standardizedType:', JSON.stringify(examsWithReportType, null, 2));
        } else {
            const totalExams = await Exam.countDocuments({});
            console.log('Total Exams in DB:', totalExams);
        }

        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

check();
