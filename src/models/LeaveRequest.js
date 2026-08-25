const mongoose = require('mongoose');

const leaveRequestSchema = new mongoose.Schema({
    applicant: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'Applicant is required']
    },
    applicantRole: {
        type: String,
        enum: ['student', 'teacher', 'staff', 'admin', 'super admin', 'support_staff', 'alumni'],
        required: true
    },
    class: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Class'
        // Optional, required only if applicant is a student
    },
    leaveType: {
        type: String,
        enum: ['full', 'half'],
        default: 'full'
    },
    halfDaySlot: {
        type: String,
        enum: ['morning', 'afternoon']
        // Required if leaveType is 'half'
    },
    startDate: {
        type: Date,
        required: [true, 'Start date is required']
    },
    endDate: {
        type: Date,
        required: [true, 'End date is required']
    },
    reason: {
        type: String,
        required: [true, 'Reason is required'],
        trim: true
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    actionBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    actionReason: { // For approval/rejection notes
        type: String,
        trim: true
    },
    rejectionReason: { // Specific reason for rejection (dropdown)
        type: String,
        trim: true
    },
    rejectionComments: { // Specific comments for rejection
        type: String,
        trim: true
    },
    actionDate: {
        type: Date
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Index for faster queries
leaveRequestSchema.index({ applicant: 1, status: 1 });
leaveRequestSchema.index({ class: 1, status: 1 });
leaveRequestSchema.index({ startDate: 1, endDate: 1 });
leaveRequestSchema.index({ applicantRole: 1, status: 1 });
leaveRequestSchema.index({ class: 1, applicantRole: 1, status: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('LeaveRequest', leaveRequestSchema);
