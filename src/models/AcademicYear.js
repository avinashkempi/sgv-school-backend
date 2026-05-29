const mongoose = require('mongoose');

const parseDate = (val) => {
    if (!val) return val;
    if (val instanceof Date) return val;
    const cleanStr = val.toString().trim();
    const match = cleanStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (match) {
        const [_, day, month, year] = match;
        return new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
    }
    return new Date(cleanStr);
};

const academicYearSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Academic year name is required'], // e.g., "2024-2025"
        trim: true,
        unique: true,
        validate: {
            validator: function (v) {
                return /^\d{4}-\d{4}$/.test(v);
            },
            message: props => `${props.value} is not a valid academic year format (YYYY-YYYY)!`
        }
    },
    startDate: {
        type: Date,
        required: [true, 'Start date is required'],
        set: parseDate
    },
    endDate: {
        type: Date,
        required: [true, 'End date is required'],
        set: parseDate
    },
    isActive: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },

    // NEW FIELDS
    status: {
        type: String,
        enum: ['draft', 'current', 'archived'],
        default: 'draft'
    },

    description: {
        type: String,
        default: ''
    },

    // Term Structure
    terms: [{
        name: {
            type: String,
            required: true
        },
        startDate: {
            type: Date,
            required: true,
            set: parseDate
        },
        endDate: {
            type: Date,
            required: true,
            set: parseDate
        },
        examPeriodStart: {
            type: Date,
            set: parseDate
        },
        examPeriodEnd: {
            type: Date,
            set: parseDate
        }
    }],

    // Metadata
    totalSchoolDays: {
        type: Number,
        default: 0
    },
    totalHolidays: {
        type: Number,
        default: 0
    },

    // Statistics Snapshot (captured during archival)
    snapshot: {
        totalStudents: Number,
        totalClasses: Number,
        totalExams: Number,
        averageAttendance: Number,
        totalSubjects: Number,
        totalTeachers: Number,
        capturedAt: Date
    },

    // Transition Tracking
    promotedFrom: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear'
    },
    promotedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear'
    },
    transitionDate: Date,
    transitionBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },

    // Configuration
    settings: {
        autoPromoteStudents: {
            type: Boolean,
            default: true
        },
        preserveTimetables: {
            type: Boolean,
            default: false
        },
        carryForwardSubjects: {
            type: Boolean,
            default: true
        },
        resetAttendance: {
            type: Boolean,
            default: true
        }
    }
});

// Ensure only one academic year is active at a time
academicYearSchema.pre('save', async function (next) {
    if (this.isActive) {
        const AcademicYear = mongoose.model('AcademicYear');
        await AcademicYear.updateMany(
            { _id: { $ne: this._id } },
            { $set: { isActive: false } }
        );
    }
    next();
});

module.exports = mongoose.model('AcademicYear', academicYearSchema);
