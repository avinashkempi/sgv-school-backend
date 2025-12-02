const mongoose = require('mongoose');

const ExamSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['unit-test', 'mid-term', 'final', 'practical'],
        required: true
    },
    class: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Class',
        required: true
    },
    subject: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subject',
        required: true
    },
    totalMarks: {
        type: Number,
        required: true
    },
    date: {
        type: Date
    },
    academicYear: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear'
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    instructions: {
        type: String
    },
    duration: {
        type: Number  // Duration in minutes
    },
    room: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    isStandardized: {
        type: Boolean,
        default: false
    },
    standardizedType: {
        type: String,
        enum: ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2', null],
        default: null
    }
});

// Indexes for efficient queries
ExamSchema.index({ class: 1, subject: 1 });
ExamSchema.index({ academicYear: 1 });
ExamSchema.index({ date: 1 });

// Ensure unique standardized exam per class+subject+academicYear
ExamSchema.index(
    { class: 1, subject: 1, academicYear: 1, standardizedType: 1 },
    {
        unique: true,
        partialFilterExpression: { isStandardized: true }
    }
);

module.exports = mongoose.model('Exam', ExamSchema);
