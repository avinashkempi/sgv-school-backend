const mongoose = require('mongoose');

const MarksSchema = new mongoose.Schema({
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    exam: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Exam',
        required: true
    },
    marksObtained: {
        type: Number,
        required: true,
        min: 0
    },
    grade: {
        type: String  // A+, A, B+, B, C, D, F etc.
    },
    percentage: {
        type: Number
    },
    remarks: {
        type: String
    },
    enteredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Indexes
MarksSchema.index({ student: 1, exam: 1 }, { unique: true });  // One marks entry per student per exam
MarksSchema.index({ exam: 1 });
MarksSchema.index({ student: 1 });
MarksSchema.index({ exam: 1, student: 1, marksObtained: -1 });

// Update timestamp on save
MarksSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('Marks', MarksSchema);
