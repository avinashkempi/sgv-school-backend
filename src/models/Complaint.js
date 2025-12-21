const mongoose = require('mongoose');

const ComplaintSchema = new mongoose.Schema({
    student: { // Deprecated, use raisedBy
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    raisedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    role: {
        type: String,
        enum: ['student', 'teacher'],
        required: true
    },
    visibility: {
        type: String,
        enum: ['teacher', 'admin', 'super_admin'],
        required: true,
        default: 'admin'
    },
    assignedTo: { // For specific teacher
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    category: {
        type: String,
        enum: ['Academic', 'Facility', 'Transport', 'Discipline', 'Other', 'Management'],
        required: true
    },
    title: {
        type: String,
        required: true
    },
    description: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['Pending', 'In Progress', 'Resolved', 'Rejected'],
        default: 'Pending'
    },
    priority: {
        type: String,
        enum: ['Low', 'Medium', 'High'],
        default: 'Medium'
    },
    adminResponse: {
        type: String
    },
    resolvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    resolvedAt: {
        type: Date
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
ComplaintSchema.index({ student: 1 });
ComplaintSchema.index({ raisedBy: 1 });
ComplaintSchema.index({ role: 1 });
ComplaintSchema.index({ status: 1 });
ComplaintSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Complaint', ComplaintSchema);
