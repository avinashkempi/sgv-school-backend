const mongoose = require('mongoose');

const classSchema = new mongoose.Schema({
    value: {
        type: String,
        required: [true, 'Class value (internal) is required'], // e.g., "1", "LKG_U", "Playhome"
        trim: true
    },
    label: {
        type: String,
        required: [true, 'Class label (display) is required'], // e.g., "1st Standard", "LKG (Ugar)"
        trim: true
    },
    name: {
        type: String,
        trim: true // Kept for legacy compatibility if external queries exist, but value/label are preferred
    },
    section: {
        type: String,
        trim: true // Optional section, e.g., "A", "B"
    },
    branch: {
        type: String,
        required: [true, 'Branch is required'],
        enum: ['Ugar', 'Mangasuli', 'Main'], // Add other branches as needed
        default: 'Main'
    },
    academicYear: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear',
        required: true
    },
    classTeacher: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Compound index to ensure unique class value per branch PER academic year
// This allows "class 1" to securely exist multiple times if it belongs to different years
classSchema.index({ value: 1, section: 1, branch: 1, academicYear: 1 }, { unique: true });

module.exports = mongoose.model('Class', classSchema);
