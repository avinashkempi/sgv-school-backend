const mongoose = require('mongoose');

const RATING_LABELS = {
    1: 'Needs significant improvement',
    2: 'Needs improvement',
    3: 'Average / Meets expectation',
    4: 'Good',
    5: 'Excellent'
};

const DATA_POINTS = [
    {
        key: 'classEngagement',
        label: 'Class Engagement',
        description: 'Attentiveness, listening, participation, and answering in class'
    },
    {
        key: 'homeworkClasswork',
        label: 'Homework & Classwork',
        description: 'Completes homework and classwork on time, regularly, and responsibly'
    },
    {
        key: 'behaviourSocial',
        label: 'Behaviour & Social Skills',
        description: 'Discipline, respectful behaviour, cooperation, interaction with classmates, and teamwork'
    },
    {
        key: 'englishComm',
        label: 'English Communication',
        description: 'Speaks in English, expresses ideas clearly, and communicates confidently'
    }
];

const ratingField = {
    type: Number,
    required: true,
    min: [1, 'Rating must be at least 1'],
    max: [5, 'Rating cannot exceed 5'],
    validate: {
        validator: Number.isInteger,
        message: 'Rating must be a whole number (1–5)'
    }
};

const studentRatingSchema = new mongoose.Schema({
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'Student is required']
    },
    subject: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subject',
        required: [true, 'Subject is required']
    },
    class: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Class',
        required: [true, 'Class is required']
    },
    teacher: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: [true, 'Teacher is required']
    },
    academicYear: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear',
        required: [true, 'Academic year is required']
    },

    // Period — month + year
    month: {
        type: Number,
        required: [true, 'Month is required'],
        min: [1, 'Month must be between 1 and 12'],
        max: [12, 'Month must be between 1 and 12']
    },
    year: {
        type: Number,
        required: [true, 'Year is required'],
        min: [2020, 'Year must be 2020 or later'],
        max: [2100, 'Year must be 2100 or earlier']
    },

    // The 4 data points (1–5 scale)
    classEngagement: ratingField,
    homeworkClasswork: ratingField,
    behaviourSocial: ratingField,
    englishComm: ratingField,

    // Auto-computed average of the 4 data points
    averageScore: {
        type: Number,
        default: 0
    },

    submittedAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Auto-compute averageScore before saving
studentRatingSchema.pre('save', function (next) {
    this.averageScore = parseFloat(
        ((this.classEngagement + this.homeworkClasswork + this.behaviourSocial + this.englishComm) / 4).toFixed(2)
    );
    this.updatedAt = Date.now();
    next();
});

// Also compute on bulk write/update operations
studentRatingSchema.pre('findOneAndUpdate', function (next) {
    const update = this.getUpdate();
    if (update.$set) {
        const s = update.$set;
        if (s.classEngagement != null && s.homeworkClasswork != null && s.behaviourSocial != null && s.englishComm != null) {
            s.averageScore = parseFloat(
                ((s.classEngagement + s.homeworkClasswork + s.behaviourSocial + s.englishComm) / 4).toFixed(2)
            );
            s.updatedAt = Date.now();
        }
    }
    next();
});

// Unique: one rating per student per subject per month/year per academic year
studentRatingSchema.index(
    { student: 1, subject: 1, month: 1, year: 1, academicYear: 1 },
    { unique: true }
);

// Query indexes
studentRatingSchema.index({ subject: 1, month: 1, year: 1 });
studentRatingSchema.index({ teacher: 1, month: 1, year: 1 });
studentRatingSchema.index({ class: 1, month: 1, year: 1 });
studentRatingSchema.index({ student: 1, academicYear: 1 });
studentRatingSchema.index({ academicYear: 1, month: 1, year: 1 });

// Expose statics for use in routes/controllers
studentRatingSchema.statics.RATING_LABELS = RATING_LABELS;
studentRatingSchema.statics.DATA_POINTS = DATA_POINTS;

module.exports = mongoose.model('StudentRating', studentRatingSchema);
