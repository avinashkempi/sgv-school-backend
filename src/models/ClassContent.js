const mongoose = require('mongoose');

const classContentSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Title is required'],
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    type: {
        type: String,
        enum: ['note', 'homework', 'news'],
        required: true
    },
    class: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Class',
        required: true
    },
    subject: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Subject'
        // Optional, as 'News' might not be linked to a specific subject
    },
    author: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    attachments: [mongoose.Schema.Types.Mixed],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

classContentSchema.index({ class: 1, createdAt: -1 });
classContentSchema.index({ class: 1, subject: 1, createdAt: -1 });
classContentSchema.index({ class: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('ClassContent', classContentSchema);

