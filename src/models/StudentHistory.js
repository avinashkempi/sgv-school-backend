const mongoose = require('mongoose');

const studentHistorySchema = new mongoose.Schema({
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    class: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Class',
        required: true
    },
    academicYear: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear',
        required: true
    },
    result: {
        type: String,
        enum: ['Promoted', 'Detained', 'Graduated', 'Left'],
        default: 'Promoted'
    },
    finalGrade: {
        type: String,
        trim: true
    },
    totalAttendancePercentage: {
        type: Number // Storing the aggregated percentage at the time of archiving
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Ensure unique history record per student per academic year
studentHistorySchema.index({ student: 1, academicYear: 1 }, { unique: true });

module.exports = mongoose.model('StudentHistory', studentHistorySchema);
