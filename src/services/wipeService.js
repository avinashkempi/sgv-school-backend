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
const wipeNonAdminData = async ({ confirmed } = {}) => {
    // Safety guard: require explicit confirmation
    if (!confirmed) {
        throw new Error('Data wipe requires explicit confirmation. Pass { confirmed: true } to proceed.');
    }

    try {
        console.log('⚠️ Starting data wipe...');

        // 1. Find all students and teachers (everyone except admin/super admin)
        const usersToDelete = await User.find({
            role: { $nin: ['admin', 'super admin'] }
        }).select('_id');

        const userIds = usersToDelete.map(u => u._id);
        console.log(`Found ${userIds.length} users to delete.`);

        if (userIds.length === 0) {
            return { success: true, message: 'No non-admin users found to delete.' };
        }

        // 2. Delete related Fee records
        const feeDeleteResult = await StudentFee.deleteMany({
            student: { $in: userIds }
        });
        console.log(`Deleted ${feeDeleteResult.deletedCount} fee records.`);

        // 3. Delete the Users
        const userDeleteResult = await User.deleteMany({
            _id: { $in: userIds }
        });
        console.log(`Deleted ${userDeleteResult.deletedCount} users.`);

        // 4. Delete Classes (To be recreated from CSV)
        const classDeleteResult = await Class.deleteMany({});
        console.log(`Deleted ${classDeleteResult.deletedCount} classes.`);

        return {
            success: true,
            message: `Successfully deleted ${userDeleteResult.deletedCount} users, ${feeDeleteResult.deletedCount} fee records, and ${classDeleteResult.deletedCount} classes.`,
            deletedUsers: userDeleteResult.deletedCount,
            deletedFees: feeDeleteResult.deletedCount,
            deletedClasses: classDeleteResult.deletedCount
        };

    } catch (error) {
        console.error('Error during data wipe:', error);
        throw error;
    }
};

module.exports = { wipeNonAdminData };
