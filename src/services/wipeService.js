const mongoose = require('mongoose');
const User = require('../models/User');
const StudentFee = require('../models/StudentFee');
// Add other related models here if needed in future (e.g. Marks, Attendance)

/**
 * Wipes all non-admin users and their related data
 * Used before a fresh import to ensure clean state
 */
const wipeNonAdminData = async () => {
    try {
        console.log('Starting data wipe...');

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

        return {
            success: true,
            message: `Successfully deleted ${userDeleteResult.deletedCount} users and ${feeDeleteResult.deletedCount} fee records.`,
            deletedUsers: userDeleteResult.deletedCount,
            deletedFees: feeDeleteResult.deletedCount
        };

    } catch (error) {
        console.error('Error during data wipe:', error);
        throw error;
    }
};

module.exports = { wipeNonAdminData };
