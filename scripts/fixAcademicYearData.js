const mongoose = require('mongoose');
const Class = require('../src/models/Class');
const Subject = require('../src/models/Subject');
const AcademicYear = require('../src/models/AcademicYear');
require('dotenv').config();

const run = async () => {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        console.error('Error: MONGODB_URI environment variable is not defined.');
        console.error('Usage: MONGODB_URI="your_mongodb_connection_string" node scripts/fixAcademicYearData.js');
        process.exit(1);
    }

    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(mongoUri);
        console.log('✅ Connected to MongoDB.');

        // Find current and archived academic years
        const currentYear = await AcademicYear.findOne({ isActive: true, status: 'current' });
        const previousYear = await AcademicYear.findOne({ status: 'archived' }); // fallback to archived status

        if (!currentYear) {
            console.error('❌ Active academic year (status "current") not found!');
            process.exit(1);
        }
        console.log(`Current Academic Year: ${currentYear.name} (${currentYear._id})`);

        if (!previousYear) {
            console.log('⚠️ Previous archived academic year not found.');
        } else {
            console.log(`Previous Academic Year: ${previousYear.name} (${previousYear._id})`);
        }

        const prevYearId = previousYear ? previousYear._id.toString() : null;
        const currYearId = currentYear._id.toString();

        // 1. Check for Classes with missing academicYear field
        const classesWithNoYear = await Class.find({
            $or: [
                { academicYear: { $exists: false } },
                { academicYear: null }
            ]
        });

        if (classesWithNoYear.length > 0) {
            console.log(`Found ${classesWithNoYear.length} classes with missing academicYear. Assigning to previous year (${prevYearId || 'unassigned'})...`);
            if (prevYearId) {
                const updateRes = await Class.updateMany(
                    { _id: { $in: classesWithNoYear.map(c => c._id) } },
                    { $set: { academicYear: prevYearId } }
                );
                console.log(`✅ Updated ${updateRes.modifiedCount} classes.`);
            } else {
                console.log('⚠️ No previous year ID found to assign these classes to.');
            }
        }

        // 2. Check for Subjects with missing academicYear field
        const subjectsWithNoYear = await Subject.find({
            $or: [
                { academicYear: { $exists: false } },
                { academicYear: null }
            ]
        });

        if (subjectsWithNoYear.length > 0) {
            console.log(`Found ${subjectsWithNoYear.length} subjects with missing academicYear. Assigning to previous year (${prevYearId || 'unassigned'})...`);
            if (prevYearId) {
                const updateRes = await Subject.updateMany(
                    { _id: { $in: subjectsWithNoYear.map(s => s._id) } },
                    { $set: { academicYear: prevYearId } }
                );
                console.log(`✅ Updated ${updateRes.modifiedCount} subjects.`);
            } else {
                console.log('⚠️ No previous year ID found to assign these subjects to.');
            }
        }

        // 3. Clone classes from previousYear to currentYear
        console.log('\n--- Cloning Classes ---');
        const oldClasses = prevYearId ? await Class.find({ academicYear: prevYearId }) : [];
        const newClasses = await Class.find({ academicYear: currYearId });
        console.log(`Found ${oldClasses.length} classes in previous year and ${newClasses.length} in current year.`);

        const classIdMap = {};
        let classesCloned = 0;

        for (const oldClass of oldClasses) {
            const exists = newClasses.find(
                nc => nc.value === oldClass.value &&
                      nc.section === oldClass.section &&
                      nc.branch === oldClass.branch
            );

            if (exists) {
                classIdMap[oldClass._id.toString()] = exists._id.toString();
                console.log(`Class already exists in current year: ${oldClass.label || oldClass.name} (Section: ${oldClass.section || 'None'})`);
            } else {
                const valueVal = oldClass.value || oldClass.name || 'unnamed';
                const labelVal = oldClass.label || oldClass.name || 'Unnamed Class';
                const nameVal = oldClass.name || oldClass.label || 'Unnamed Class';

                const newClass = new Class({
                    value: valueVal,
                    label: labelVal,
                    name: nameVal,
                    section: oldClass.section,
                    branch: oldClass.branch,
                    academicYear: currYearId,
                    classTeacher: null // Reset class teacher for reassignment
                });

                const saved = await newClass.save();
                classIdMap[oldClass._id.toString()] = saved._id.toString();
                classesCloned++;
                console.log(`✅ Cloned Class: ${newClass.label} (Section: ${newClass.section || 'None'})`);
            }
        }
        console.log(`Total classes cloned: ${classesCloned}`);

        // 4. Clone subjects from previousYear to currentYear
        console.log('\n--- Cloning Subjects ---');
        const oldSubjects = prevYearId ? await Subject.find({ academicYear: prevYearId }) : [];
        const newSubjects = await Subject.find({ academicYear: currYearId });
        console.log(`Found ${oldSubjects.length} subjects in previous year and ${newSubjects.length} in current year.`);

        let subjectsCloned = 0;

        for (const oldSubj of oldSubjects) {
            const newClassId = classIdMap[oldSubj.class.toString()];
            if (!newClassId) {
                console.log(`⚠️ Skipping subject ${oldSubj.name} because its class (${oldSubj.class}) could not be mapped.`);
                continue;
            }

            const exists = newSubjects.find(
                ns => ns.name === oldSubj.name &&
                      ns.class.toString() === newClassId
            );

            if (exists) {
                console.log(`Subject already exists in current year: ${oldSubj.name} in Class ${newClassId}`);
            } else {
                const newSubj = new Subject({
                    name: oldSubj.name,
                    class: newClassId,
                    academicYear: currYearId,
                    globalSubject: oldSubj.globalSubject,
                    teachers: [] // Reset teachers for reassignment
                });

                await newSubj.save();
                subjectsCloned++;
                console.log(`✅ Cloned Subject: ${newSubj.name} for Class ${newClassId}`);
            }
        }
        console.log(`Total subjects cloned: ${subjectsCloned}`);

        console.log('\n🎉 DB Fix and Migration completed successfully!');
    } catch (err) {
        console.error('❌ Error executing database fix:', err);
    } finally {
        await mongoose.connection.close();
        console.log('Database connection closed.');
    }
};

run();
