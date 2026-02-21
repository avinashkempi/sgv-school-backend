const mongoose = require('mongoose');

const teacherHistorySchema = new mongoose.Schema({
    teacher: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    academicYear: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear',
        required: true
    },
    classes: [{
        class: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Class'
        },
        subject: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Subject'
        },
        role: {
            type: String,
            enum: ['subject_teacher', 'class_teacher'],
            default: 'subject_teacher'
        }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Ensure unique history record per teacher per academic year
teacherHistorySchema.index({ teacher: 1, academicYear: 1 }, { unique: true });

module.exports = mongoose.model('TeacherHistory', teacherHistorySchema);
