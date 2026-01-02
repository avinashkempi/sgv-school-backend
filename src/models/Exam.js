const mongoose = require('mongoose');

const ExamSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['unit-test', 'mid-term', 'final', 'practical'],
        required: false  // Made optional for backward compatibility
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
        default: true  // Now defaults to true - all new exams are standardized
    },
    standardizedType: {
        type: String,
        enum: ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'],
        required: true  // Made required - must be one of the 6 fixed types
    },
    status: {
        type: String,
        enum: ['draft', 'scheduled', 'ongoing', 'completed', 'cancelled'],
        default: 'scheduled'
    },
    marksPublished: {
        type: Boolean,
        default: false
    },
    startTime: {
        type: String  // e.g., "09:00 AM"
    },
    endTime: {
        type: String  // e.g., "12:00 PM"
    },
    syllabus: [{
        type: String  // Topics covered in the exam
    }],
    term: {
        type: String,
        enum: ['1st term', '2nd term', 'annual'],
        default: function () {
            // Auto-calculate based on standardizedType
            if (['FA1', 'FA2', 'SA1'].includes(this.standardizedType)) {
                return '1st term';
            } else if (['FA3', 'FA4', 'SA2'].includes(this.standardizedType)) {
                return '2nd term';
            }
            return 'annual';
        }
    }
});

// Indexes for efficient queries
ExamSchema.index({ class: 1, subject: 1 });
ExamSchema.index({ academicYear: 1 });
ExamSchema.index({ date: 1 });
ExamSchema.index({ status: 1 });
ExamSchema.index({ marksPublished: 1 });
ExamSchema.index({ term: 1 });

// Ensure unique standardized exam per class+subject+academicYear
ExamSchema.index(
    { class: 1, subject: 1, academicYear: 1, standardizedType: 1 },
    {
        unique: true,
        partialFilterExpression: { isStandardized: true }
    }
);

module.exports = mongoose.model('Exam', ExamSchema);
