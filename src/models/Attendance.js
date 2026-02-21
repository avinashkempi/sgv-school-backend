const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    role: {
        type: String,
        enum: ['student', 'teacher', 'staff', 'admin'],
        required: true
    },
    class: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Class'
        // Optional, required for students
    },
    subject: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subject'
        // Optional - for period-wise/subject-specific attendance
    },
    date: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['present', 'absent', 'late', 'excused'],
        required: true
    },
    markedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    period: {
        type: Number  // For period-wise attendance: 1, 2, 3, etc.
    },
    remarks: {
        type: String
    },
    academicYear: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear',
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Indexes for efficient queries
AttendanceSchema.index({ user: 1, date: 1, academicYear: 1 });
AttendanceSchema.index({ class: 1, date: 1, academicYear: 1 });
AttendanceSchema.index({ role: 1, date: 1, academicYear: 1 });
AttendanceSchema.index({ subject: 1, date: 1, academicYear: 1 });

// Compound index for preventing duplicate attendance records
AttendanceSchema.index({ user: 1, date: 1, class: 1, subject: 1, period: 1, academicYear: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Attendance', AttendanceSchema);
