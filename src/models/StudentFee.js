const mongoose = require('mongoose');

const studentFeeSchema = new mongoose.Schema({
    student: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    academicYear: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AcademicYear'
    },
    branch: {
        type: String, // Calculated snapshot from student's class
        trim: true
    },
    class: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Class'
    },

    // Fee Details
    totalFees: {
        type: Number,
        default: 0
    },
    totalPaid: {
        type: Number,
        default: 0
    },
    pendingAmount: {
        type: Number,
        default: 0
    },
    concession: {
        type: Number,
        default: 0
    },

    // Installments / Payment History
    payments: [{
        amount: {
            type: Number,
            required: true
        },
        date: {
            type: Date,
            default: Date.now
        },
        invoiceNumber: {
            type: String,
            trim: true
        },
        installmentNumber: {
            type: Number // 1, 2, 3, etc.
        },
        paymentMode: {
            type: String,
            enum: ['Cash', 'UPI', 'Bank Transfer', 'Cheque', 'Other'],
            default: 'Cash'
        },
        remarks: String
    }],

    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Middleware to update pending amount before save
studentFeeSchema.pre('save', function (next) {
    this.updatedAt = Date.now();

    // Recalculate total paid from payments array
    if (this.payments && this.payments.length > 0) {
        this.totalPaid = this.payments.reduce((sum, payment) => sum + (payment.amount || 0), 0);
    }

    // Recalculate pending: Total - Paid - Concession
    this.pendingAmount = this.totalFees - this.totalPaid - this.concession;

    next();
});

// Compound index to ensure one fee record per student per year
studentFeeSchema.index({ student: 1, academicYear: 1 }, { unique: true });

module.exports = mongoose.model('StudentFee', studentFeeSchema);
