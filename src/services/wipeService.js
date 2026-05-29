const mongoose = require('mongoose');
const User = require('../models/User');
const StudentFee = require('../models/StudentFee');
const Class = require('../models/Class');

/**
 * Wipes all non-admin users and their related data
 * Used before a fresh import to ensure clean state
 * @param {Object} options
 * @param {boolean} options.confirmed - Must be explicitly true to proceed
 */
const wipeNonAdminData = async ({ confirmed, academicYearId, global = false } = {}) => {
    // Safety guard: require explicit confirmation
    if (!confirmed) {
        throw new Error('Data wipe requires explicit confirmation. Pass { confirmed: true } to proceed.');
    }

    if (!global && !academicYearId) {
        throw new Error('Academic year scoped wipe requires academicYearId.');
    }

    try {
        console.log('⚠️ Starting data wipe...');

        // 1. Find only students in the selected academic year (preserve teachers, support staff, alumni, etc.)
        const studentFilter = global ? { role: 'student' } : { role: 'student', academicYear: academicYearId };
        const usersToDelete = await User.find(studentFilter).select('_id');

        const userIds = usersToDelete.map(u => u._id);
        console.log(`Found ${userIds.length} students to delete.`);

        if (userIds.length === 0) {
            return { success: true, message: 'No students found to delete.' };
        }

        // 2. Delete related Fee records
        const feeDeleteResult = await StudentFee.deleteMany({
            student: { $in: userIds }
        });
        console.log(`Deleted ${feeDeleteResult.deletedCount} fee records.`);

        // 3. Delete the Student Users
        const userDeleteResult = await User.deleteMany({
            _id: { $in: userIds }
        });
        console.log(`Deleted ${userDeleteResult.deletedCount} students.`);

        // NOTE: Classes are NOT deleted to preserve subject & teacher assignments.
        // The CSV importer will reuse existing classes by name.

        return {
            success: true,
            message: `Successfully deleted ${userDeleteResult.deletedCount} students and ${feeDeleteResult.deletedCount} fee records. Classes, subjects, and teacher assignments preserved.`,
            deletedUsers: userDeleteResult.deletedCount,
            deletedFees: feeDeleteResult.deletedCount
        };

    } catch (error) {
        console.error('Error during data wipe:', error);
        throw error;
    }
};

module.exports = { wipeNonAdminData };
