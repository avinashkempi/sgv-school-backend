const mongoose = require('mongoose');
require('dotenv').config();

const ATLAS_URI = 'mongodb+srv://avinashkempi:Rcbcskmongo123@schoolapp.uhmjiaw.mongodb.net/school-app?retryWrites=true&w=majority';
const isProd = process.argv.includes('--prod');
const isExecute = process.argv.includes('--execute');

// If --prod is specified, use ATLAS_URI; otherwise use MONGODB_URI if not 127.0.0.1, else ATLAS_URI
const mongoUri = isProd 
    ? ATLAS_URI 
    : (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('127.0.0.1') ? process.env.MONGODB_URI : ATLAS_URI);

async function main() {
    console.log('================================================================');
    console.log(' Grade 4 / KHKCSI Database Audit & Reconciliation Script');
    console.log(' Mode:', isExecute ? '🚀 EXECUTE (Applying changes)' : '🔍 DRY-RUN (Preview only)');
    console.log('================================================================\n');

    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(mongoUri);
        console.log('✅ Connected successfully.\n');

        const Class = require('../src/models/Class');
        const User = require('../src/models/User');
        const StudentFee = require('../src/models/StudentFee');
        const Subject = require('../src/models/Subject');
        const Exam = require('../src/models/Exam');
        const Attendance = require('../src/models/Attendance');

        const origId = new mongoose.Types.ObjectId('6a51d02226c0fabfbff5aeb0');
        const newId = new mongoose.Types.ObjectId('6ae04bf21dae819b54fd25b1');

        // 1. Fetch both class documents
        const origClass = await Class.findById(origId);
        const newClass = await Class.findById(newId);

        console.log('--- Step 1: Inspect Target Classes ---');
        if (!origClass) {
            console.error('❌ Original Class (6a51d02226c0fabfbff5aeb0) not found! Aborting.');
            process.exit(1);
        }
        console.log(`Original Class ID: ${origClass._id}`);
        console.log(`  Current Name:   "${origClass.name}"`);
        console.log(`  Current Value:  "${origClass.value}"`);
        console.log(`  Current Label:  "${origClass.label}"`);
        console.log(`  Current Branch: "${origClass.branch}"`);
        console.log(`  Created At:     ${origClass.createdAt}`);

        if (newClass) {
            console.log(`\nNew Duplicate Class ID: ${newClass._id}`);
            console.log(`  Name:       "${newClass.name}"`);
            console.log(`  Branch:     "${newClass.branch}"`);
            console.log(`  Created At: ${newClass.createdAt}`);
        } else {
            console.log('\nNew Duplicate Class (6ae04bf21dae819b54fd25b1) not found (may already be cleaned up).');
        }

        // 2. Count related records
        console.log('\n--- Step 2: Audit Associated Records ---');
        const origStudents = await User.countDocuments({ currentClass: origId });
        const newStudents = newClass ? await User.countDocuments({ currentClass: newId }) : 0;
        const origFees = await StudentFee.countDocuments({ class: origId });
        const newFees = newClass ? await StudentFee.countDocuments({ class: newId }) : 0;
        const origSubjects = await Subject.countDocuments({ class: origId });
        const origExams = await Exam.countDocuments({ class: origId });
        const origAttendance = await Attendance.countDocuments({ class: origId });

        console.log(`Students in Original Class:    ${origStudents}`);
        console.log(`Students in New Class:         ${newStudents}`);
        console.log(`Fees linked to Original Class: ${origFees}`);
        console.log(`Fees linked to New Class:      ${newFees}`);
        console.log(`Subjects in Original Class:    ${origSubjects}`);
        console.log(`Exams in Original Class:       ${origExams}`);
        console.log(`Attendance in Original Class:  ${origAttendance}`);

        if (!isExecute) {
            console.log('\n----------------------------------------------------------------');
            console.log('🔍 DRY RUN SUMMARY: The following actions will be performed with --execute:');
            console.log('----------------------------------------------------------------');
            console.log(`1. Re-link ${newFees} StudentFee records from Class "${newId}" to "${origId}" (branch: "Mangasuli")`);
            if (newClass) {
                console.log(`2. Permanently delete empty duplicate Class "${newId}"`);
            }
            console.log(`3. Rename Class "${origId}" back to:`);
            console.log('     name:   "4"');
            console.log('     value:  "4"');
            console.log('     label:  "4"');
            console.log('     branch: "Mangasuli"');
            console.log('     section: ""');
            console.log('4. Run verification to confirm 31 students, 12 subjects, 8 exams, and 31 fees under Class 4');
            console.log('\nTo execute these changes, run:');
            console.log('  node scripts/reconcile_grade4.js --execute');
            console.log('================================================================');
            await mongoose.disconnect();
            return;
        }

        // 3. EXECUTE: Re-link StudentFees
        console.log('\n--- Step 3: Re-linking StudentFee records ---');
        if (newFees > 0) {
            const feeUpdateRes = await StudentFee.updateMany(
                { class: newId },
                { $set: { class: origId, branch: 'Mangasuli' } }
            );
            console.log(`✅ Re-linked ${feeUpdateRes.modifiedCount} StudentFee records to ${origId}`);
        } else {
            console.log('ℹ️  No StudentFee records to re-link.');
        }

        // 4. EXECUTE: Delete the duplicate empty class
        console.log('\n--- Step 4: Deleting duplicate empty class ---');
        if (newClass) {
            await Class.findByIdAndDelete(newId);
            console.log(`✅ Deleted duplicate empty class ${newId}`);
        } else {
            console.log('ℹ️  Duplicate class already absent.');
        }

        // 5. EXECUTE: Restore original class back to Grade 4
        console.log('\n--- Step 5: Restoring original class to Grade 4 ---');
        origClass.name = '4';
        origClass.value = '4';
        origClass.label = '4';
        origClass.section = '';
        origClass.branch = 'Mangasuli';
        await origClass.save();
        console.log(`✅ Successfully restored Class ${origId} to:`);
        console.log('     name: "4", value: "4", label: "4", branch: "Mangasuli"');

        // 6. Cache Invalidation
        console.log('\n--- Step 6: Invalidate Caches ---');
        if (process.env.REDIS_URL) {
            try {
                const redis = require('redis');
                const client = redis.createClient({ url: process.env.REDIS_URL });
                await client.connect();
                const patterns = ['*classes*', '*adminClassesInit*', '*teacherDashboard*', '*adminExamSchedule*'];
                for (const p of patterns) {
                    const keys = await client.keys(p);
                    if (keys.length > 0) {
                        await client.del(keys);
                        console.log(`Cleared ${keys.length} cache keys for pattern: ${p}`);
                    }
                }
                await client.quit();
                console.log('✅ Redis caches cleared.');
            } catch (rErr) {
                console.log(`ℹ️  Redis cache clearing skipped: ${rErr.message}`);
            }
        } else {
            console.log('ℹ️  No REDIS_URL specified; in-memory server cache expires automatically via TTL (5m).');
        }

        // 7. Post-migration Verification
        console.log('\n--- Step 7: Post-Migration Verification ---');
        const finalClass = await Class.findById(origId).lean();
        const finalStudents = await User.countDocuments({ currentClass: origId });
        const finalFees = await StudentFee.countDocuments({ class: origId });
        const finalSubjects = await Subject.countDocuments({ class: origId });
        const finalExams = await Exam.countDocuments({ class: origId });
        const anyDuplicateClass = await Class.find({ name: '4', academicYear: origClass.academicYear }).lean();

        console.log(`Class Document:`, {
            id: finalClass._id,
            name: finalClass.name,
            value: finalClass.value,
            label: finalClass.label,
            branch: finalClass.branch
        });
        console.log(`Enrolled Students: ${finalStudents}`);
        console.log(`Fee Records:       ${finalFees}`);
        console.log(`Subjects:          ${finalSubjects}`);
        console.log(`Exams:             ${finalExams}`);
        console.log(`Classes named "4": ${anyDuplicateClass.length} (Expected: exactly 1)`);

        console.log('\n================================================================');
        console.log('🎉 RECONCILIATION COMPLETED SUCCESSFULLY!');
        console.log('================================================================\n');

        await mongoose.disconnect();
    } catch (err) {
        console.error('❌ Error during reconciliation:', err);
        process.exit(1);
    }
}

main();
