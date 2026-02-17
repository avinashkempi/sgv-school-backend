const mongoose = require('mongoose');
const AcademicYear = require('../models/AcademicYear');
const Class = require('../models/Class');
const Subject = require('../models/Subject');
const User = require('../models/User');
const ClassContent = require('../models/ClassContent');
const connectDB = require('../config/database');
require('dotenv').config();

const runTest = async () => {
    await connectDB();

    try {
        // 1. Create Academic Year
        console.log('Creating Academic Year...');
        const year = new AcademicYear({
            name: '2025-2026',
            startDate: new Date('2025-06-01'),
            endDate: new Date('2026-05-31'),
            isActive: true
        });
        await year.save();
        console.log('Academic Year Created:', year.name);

        // 2. Create Teacher
        console.log('Creating Teacher...');
        const teacher = new User({
            name: 'Test Teacher',
            email: 'teacher@test.com',
            password: 'password123',
            phone: '9876543210',
            role: 'teacher',
            joiningDate: new Date(),
            designation: 'Senior Teacher'
        });
        await teacher.save();
        console.log('Teacher Created:', teacher.name);

        // 3. Create Class
        console.log('Creating Class...');
        const newClass = new Class({
            name: '10th Standard',
            section: 'A',
            branch: 'Main',
            academicYear: year._id,
            classTeacher: teacher._id
        });
        await newClass.save();
        console.log('Class Created:', newClass.name);

        // 4. Create Subject
        console.log('Creating Subject...');
        const subject = new Subject({
            name: 'Mathematics',
            class: newClass._id,
            teachers: [teacher._id]
        });
        await subject.save();
        console.log('Subject Created:', subject.name);

        // 5. Create Student
        console.log('Creating Student...');
        const student = new User({
            name: 'Test Student',
            email: 'student@test.com',
            password: 'password123',
            phone: '9123456789',
            role: 'student',
            currentClass: newClass._id,
            academicYear: year._id,
            admissionDate: new Date(),
            guardianName: 'Test Parent',
            guardianPhone: '9988776655'
        });
        await student.save();
        console.log('Student Created:', student.name);

        // 6. Post Class Content
        console.log('Posting Class Content...');
        const content = new ClassContent({
            title: 'Math Homework 1',
            description: 'Solve chapter 1 exercises',
            type: 'Homework',
            class: newClass._id,
            subject: subject._id,
            author: teacher._id
        });
        await content.save();
        console.log('Content Posted:', content.title);

        // 7. Verify Content Fetch
        console.log('Verifying Content Fetch...');
        const fetchedContent = await ClassContent.find({ class: newClass._id });
        if (fetchedContent.length > 0) {
            console.log('SUCCESS: Content fetched successfully!');
        } else {
            console.log('FAILURE: No content found.');
        }

        // Cleanup (Optional, commented out to inspect DB if needed)
        // await AcademicYear.deleteMany({});
        // await Class.deleteMany({});
        // await Subject.deleteMany({});
        // await User.deleteMany({ email: { $in: ['teacher@test.com', 'student@test.com'] } });
        // await ClassContent.deleteMany({});

    } catch (err) {
        console.error('Test Failed:', err);
    } finally {
        mongoose.connection.close();
    }
};

runTest();
