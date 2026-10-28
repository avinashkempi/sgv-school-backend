const mongoose = require('mongoose');
const User = require('../src/models/User');
const Subject = require('../src/models/Subject');
const AcademicYear = require('../src/models/AcademicYear');
const StudentRating = require('../src/models/StudentRating');
require('dotenv').config();

async function seedStudentRatings() {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/sgv-school';
    console.log('Connecting to MongoDB at:', mongoUri);

    try {
        await mongoose.connect(mongoUri, { family: 4, serverSelectionTimeoutMS: 5000 });
        console.log('✅ Connected to MongoDB.');

        // 1. Get active academic year
        let academicYear = await AcademicYear.findOne({ isActive: true });
        if (!academicYear) {
            academicYear = await AcademicYear.findOne().sort({ createdAt: -1 });
        }
        if (!academicYear) {
            console.error('❌ No Academic Year found in database.');
            process.exit(1);
        }
        console.log(`Using Academic Year: ${academicYear.name} (${academicYear._id})`);

        // 2. Fetch all active students
        const students = await User.find({ role: 'student', isActive: true });
        console.log(`Found ${students.length} active students.`);
        if (students.length === 0) {
            console.log('⚠️ No active students found to rate.');
            process.exit(0);
        }

        // 3. Fetch ratable subjects for the academic year
        const subjects = await Subject.find({
            academicYear: academicYear._id,
            ratingEnabled: { $ne: false }
        }).populate('class teachers');

        console.log(`Found ${subjects.length} ratable subjects.`);
        if (subjects.length === 0) {
            console.log('⚠️ No ratable subjects found in this academic year.');
            process.exit(0);
        }

        // 4. Fetch a fallback teacher in case subject has no teacher
        const fallbackTeacher = await User.findOne({ role: 'teacher', isActive: true }) || await User.findOne({ role: { $in: ['teacher', 'admin', 'super admin'] } });
        if (!fallbackTeacher) {
            console.error('❌ No teacher or staff user found in database.');
            process.exit(1);
        }

        // 5. Seed ratings for 5 months: June (6) to October (10) 2026
        const currentYear = 2026;
        const monthsToSeed = [6, 7, 8, 9, 10];
        let insertedCount = 0;
        let updatedCount = 0;

        for (const month of monthsToSeed) {
            console.log(`Generating ratings for month ${month}/${currentYear}...`);

            for (const sub of subjects) {
                if (!sub.class) continue;
                const teacherId = (sub.teachers && sub.teachers.length > 0)
                    ? sub.teachers[0]._id
                    : fallbackTeacher._id;

                // Find students belonging to this class
                const classStudents = students.filter(s =>
                    s.currentClass && s.currentClass.toString() === sub.class._id.toString()
                );

                for (const student of classStudents) {
                    // Seed realistic scores (mostly 3-5, with variance per student)
                    // Use deterministic hash from student ID + subject ID + month so values are consistent
                    const seedNum = (student._id.toString().charCodeAt(10) || 3) +
                        (sub._id.toString().charCodeAt(10) || 2) +
                        month;

                    const classEngagement = 3 + (seedNum % 3); // 3, 4, 5
                    const homeworkClasswork = 3 + ((seedNum + 1) % 3);
                    const behaviourSocial = 4 + (seedNum % 2); // 4, 5
                    const englishComm = 3 + ((seedNum + 2) % 3);
                    const averageScore = parseFloat(
                        ((classEngagement + homeworkClasswork + behaviourSocial + englishComm) / 4).toFixed(2)
                    );

                    const filter = {
                        student: student._id,
                        subject: sub._id,
                        class: sub.class._id,
                        academicYear: academicYear._id,
                        month,
                        year: currentYear
                    };

                    const update = {
                        $set: {
                            teacher: teacherId,
                            lastModifiedBy: teacherId,
                            subjectName: sub.name,
                            classEngagement,
                            homeworkClasswork,
                            behaviourSocial,
                            englishComm,
                            averageScore,
                            submittedAt: new Date(currentYear, month - 1, 25),
                            updatedAt: new Date()
                        }
                    };

                    const res = await StudentRating.updateOne(filter, update, { upsert: true });
                    if (res.upsertedCount > 0) insertedCount++;
                    else if (res.modifiedCount > 0) updatedCount++;
                }
            }
        }

        console.log(`\n🎉 Seed Complete!`);
        console.log(`- Created ${insertedCount} new rating records.`);
        console.log(`- Updated ${updatedCount} existing rating records.`);
        process.exit(0);

    } catch (err) {
        console.error('❌ Error seeding student ratings:', err.message);
        process.exit(1);
    }
}

seedStudentRatings();
