const mongoose = require('mongoose');

const subjectSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Subject name is required'],
        trim: true
    },
    class: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Class',
        required: [true, 'Class is required']
    },
    globalSubject: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'GlobalSubject'
    },
    teachers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
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

// Ensure a subject name is unique per class per academic year
subjectSchema.index({ name: 1, class: 1, academicYear: 1 }, { unique: true });

module.exports = mongoose.model('Subject', subjectSchema);
