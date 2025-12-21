const mongoose = require('mongoose');

const FeePaymentSchema = new mongoose.Schema({
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    class: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Class',
        required: true
    },
    academicYear: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear',
        required: true
    },
    feeStructure: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'FeeStructure',
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'online', 'cheque', 'card'],
        required: true
    },
    transactionId: {
        type: String
    },
    receiptNumber: {
        type: String,
        required: true,
        unique: true
    },
    bookNumber: {
        type: String
    },
    manualReceiptNumber: {
        type: String
    },
    status: {
        type: String,
        enum: ['success', 'pending', 'failed'],
        default: 'success'
    },
    remarks: {
        type: String
    },
    collectedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User' // Admin/Staff who collected the fee
    },
    paymentDate: {
        type: Date,
        default: Date.now
    }
});

// Indexes
FeePaymentSchema.index({ student: 1 });
FeePaymentSchema.index({ class: 1 });
FeePaymentSchema.index({ academicYear: 1 });
FeePaymentSchema.index({ status: 1 });
FeePaymentSchema.index({ paymentDate: -1 });

module.exports = mongoose.model('FeePayment', FeePaymentSchema);
