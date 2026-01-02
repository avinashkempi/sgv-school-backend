const mongoose = require('mongoose');

const notificationPreferenceSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    // Category preferences
    categories: {
        exam: { type: Boolean, default: true },
        fee: { type: Boolean, default: true },
        attendance: { type: Boolean, default: true },
        complaint: { type: Boolean, default: true },
        event: { type: Boolean, default: true },
        general: { type: Boolean, default: true },
        leave: { type: Boolean, default: true },
        announcement: { type: Boolean, default: true }
    },
    // Priority preferences
    priorities: {
        low: { type: Boolean, default: true },
        medium: { type: Boolean, default: true },
        high: { type: Boolean, default: true },
        urgent: { type: Boolean, default: true }
    },
    // Notification methods
    pushEnabled: {
        type: Boolean,
        default: true
    },
    emailEnabled: {
        type: Boolean,
        default: false
    },
    smsEnabled: {
        type: Boolean,
        default: false
    },
    // Quiet hours
    quietHoursEnabled: {
        type: Boolean,
        default: false
    },
    quietHoursStart: {
        type: String, // Format: "HH:MM" e.g., "22:00"
        default: "22:00"
    },
    quietHoursEnd: {
        type: String, // Format: "HH:MM" e.g., "07:00"
        default: "07:00"
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('NotificationPreference', notificationPreferenceSchema);
