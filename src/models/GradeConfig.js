const mongoose = require('mongoose');

const GradeConfigSchema = new mongoose.Schema({
    academicYear: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear'
    },
    gradeRanges: [{
        grade: {
            type: String,
            required: true  // "A+", "A", "B+", "B", "C"
        },
        minPercentage: {
            type: Number,
            required: true,
            min: 0,
            max: 100
        },
        maxPercentage: {
            type: Number,
            required: true,
            min: 0,
            max: 100
        },
        description: {
            type: String  // "Excellent", "Very Good", "Good", etc.
        }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Index for quick lookup
GradeConfigSchema.index({ academicYear: 1 });

// Helper method to get grade from percentage
GradeConfigSchema.methods.getGrade = function (percentage) {
    for (let range of this.gradeRanges) {
        if (percentage >= range.minPercentage && percentage <= range.maxPercentage) {
            return {
                grade: range.grade,
                description: range.description
            };
        }
    }
    return { grade: 'C', description: 'Below 30' };  // Default if no match
};

module.exports = mongoose.model('GradeConfig', GradeConfigSchema);
