const express = require('express');
const router = express.Router();
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const FeeStructure = require('../models/FeeStructure');
const FeePayment = require('../models/FeePayment');
const StudentFee = require('../models/StudentFee');
const User = require('../models/User');
const Class = require('../models/Class');
const { sendTargetedNotification } = require('../services/notificationService');

// Helper to generate receipt number
const generateReceiptNumber = async () => {
    const date = new Date();
    const year = date.getFullYear().toString().substr(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `RCP${year}${month}`;

    // Find last receipt of this month
    const lastPayment = await FeePayment.findOne({
        receiptNumber: new RegExp(`^${prefix}`)
    }).sort({ receiptNumber: -1 });

    let sequence = '0001';
    if (lastPayment) {
        const lastSeq = parseInt(lastPayment.receiptNumber.slice(-4));
        sequence = (lastSeq + 1).toString().padStart(4, '0');
    }

    return `${prefix}${sequence}`;
};

// @route   POST /api/fees/structure
// @desc    Create or Update fee structure for a class
// @access  Admin/Super Admin
router.post('/structure', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {

        const { classId, academicYearId, components, paymentSchedule, type, students } = req.body;

        if (!classId || !academicYearId) {
            return res.status(400).json({ message: "Class and Academic Year are required" });
        }

        // Calculate total amount
        if (!components || !Array.isArray(components)) {
            return res.status(400).json({ message: "Components must be an array" });
        }
        const totalAmount = components.reduce((sum, comp) => sum + Number(comp.amount), 0);

        let feeStructure;

        if (type === 'student_specific') {
            // For specific students, we always create a new structure for now
            feeStructure = new FeeStructure({
                class: classId,
                academicYear: academicYearId,
                components,
                paymentSchedule,
                totalAmount,
                type,
                students
            });
        } else {
            // Default class structure
            feeStructure = await FeeStructure.findOne({
                class: classId,
                academicYear: academicYearId,
                type: 'class_default'
            });

            if (feeStructure) {
                // Update existing
                feeStructure.components = components;
                feeStructure.paymentSchedule = paymentSchedule;
                feeStructure.totalAmount = totalAmount;
                feeStructure.updatedAt = Date.now();
            } else {
                // Create new
                feeStructure = new FeeStructure({
                    class: classId,
                    academicYear: academicYearId,
                    components,
                    paymentSchedule,
                    totalAmount,
                    type: 'class_default'
                });
            }
        }

        await feeStructure.save();

        // Notify relevant users
        if (type === 'class_default') {
            await sendTargetedNotification('class', classId, {
                title: 'New Fee Structure',
                message: 'A new fee structure has been updated for your class.',
                type: 'Fee'
            });
        } else if (type === 'student_specific' && students && students.length > 0) {
            for (const studentId of students) {
                await sendTargetedNotification('user', studentId, {
                    title: 'New Fee Structure',
                    message: 'Your fee structure has been updated.',
                    type: 'Fee'
                });
            }
        }

        res.json(feeStructure);
    } catch (err) {
        console.error("Error in POST /structure:", err);
        res.status(500).send('Server Error: ' + err.message);
    }
});

// @route   GET /api/fees/structure/class/:classId
// @desc    Get fee structure for a class (current academic year)
// @access  Private
router.get('/structure/class/:classId', auth, async (req, res) => {
    try {
        // Ideally we should get the active academic year from a config or passed in query
        // For now, let's try to find the structure associated with the class's current academic year
        // or just the latest one.

        const classData = await Class.findById(req.params.classId);
        if (!classData) return res.status(404).json({ message: 'Class not found' });

        let feeStructure;
        if (classData.academicYear) {
            feeStructure = await FeeStructure.findOne({
                class: req.params.classId,
                academicYear: classData.academicYear,
                type: 'class_default'
            });
        }

        // If not found by specific academic year, get the latest one
        if (!feeStructure) {
            feeStructure = await FeeStructure.findOne({
                class: req.params.classId,
                type: 'class_default'
            }).sort({ createdAt: -1 });
        }

        if (!feeStructure) {
            // Return empty structure instead of 404 to avoid client errors
            return res.json({
                components: [],
                totalAmount: 0,
                type: 'class_default'
            });
        }

        res.json(feeStructure);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/fees/payment
// @desc    Record a fee payment
// @access  Admin/Super Admin
router.post('/payment', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const { studentId, amount, paymentMethod, transactionId, remarks, bookNumber, manualReceiptNumber } = req.body;

        const student = await User.findById(studentId);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        if (!student.currentClass || !student.academicYear) {
            return res.status(400).json({ message: 'Student not assigned to a class or academic year' });
        }

        const feeStructure = await FeeStructure.findOne({
            class: student.currentClass,
            academicYear: student.academicYear,
            type: 'class_default'
        });

        // Also check for specific structures to validate if the student has ANY fee structure
        const specificStructures = await FeeStructure.find({
            class: student.currentClass,
            academicYear: student.academicYear,
            type: 'student_specific',
            students: studentId
        });

        if (!feeStructure && specificStructures.length === 0) {
            return res.status(400).json({ message: 'Fee structure not defined for this student\'s class' });
        }

        const receiptNumber = await generateReceiptNumber();

        const payment = new FeePayment({
            student: studentId,
            class: student.currentClass,
            academicYear: student.academicYear,
            // feeStructure: feeStructure._id, // We might need to link to specific structure if applicable, but for now we just track payment against student/class
            // For now, let's keep it optional or link to default if available. 
            // If we want to track against specific component, we need more complex logic.
            // For now, we'll just link to the default one if it exists, or the first specific one.
            feeStructure: feeStructure ? feeStructure._id : specificStructures[0]?._id,
            amount,
            paymentMethod,
            transactionId,
            receiptNumber,
            bookNumber,
            manualReceiptNumber,
            remarks,
            collectedBy: req.user.userId
        });

        await payment.save();

        // Notify Student
        await sendTargetedNotification('user', studentId, {
            title: 'Fee Payment Successful',
            message: `Payment of ${amount} received. Receipt: ${receiptNumber}`,
            type: 'Fee'
        });

        res.json(payment);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/fees/student/:studentId
// @desc    Get student fee status and history
// @access  Private (Admin, or Student for own data)
router.get('/student/:studentId', auth, async (req, res) => {
    try {
        // Authorization check
        if (req.user.role === 'student' && req.user.userId !== req.params.studentId) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const student = await User.findById(req.params.studentId);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        // CHECK FOR IMPORTED FEE RECORD FIRST (StudentFee)
        // This is the source of truth for imported data
        const StudentFee = require('../models/StudentFee');
        const studentFee = await StudentFee.findOne({
            student: req.params.studentId,
            academicYear: student.academicYear
        });

        if (studentFee) {
            // Map payments to match expected frontend structure
            const mappedPayments = studentFee.payments.map(p => ({
                _id: p._id,
                amount: p.amount,
                paymentDate: p.date,
                receiptNumber: p.invoiceNumber, // Map Invoice to Receipt
                paymentMethod: p.paymentMode,
                status: 'success', // Imported payments are assumed successful
                installmentNumber: p.installmentNumber
            })).sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate));

            return res.json({
                feeStructure: {
                    totalAmount: studentFee.totalFees,
                    components: [
                        { name: "Tuition & Other Fees", amount: studentFee.totalFees }
                    ]
                },
                totalFees: studentFee.totalFees,
                paidAmount: studentFee.totalPaid,
                pendingAmount: studentFee.pendingAmount,
                concession: studentFee.concession || 0,
                payments: mappedPayments
            });
        }

        // --- FALLBACK TO LEGACY/CALCULATED LOGIC ---

        // Get Fee Structure (Default)
        const defaultFeeStructure = await FeeStructure.findOne({
            class: student.currentClass,
            academicYear: student.academicYear,
            type: 'class_default'
        });

        // Get Specific Fee Structures
        const specificFeeStructures = await FeeStructure.find({
            class: student.currentClass,
            academicYear: student.academicYear,
            type: 'student_specific',
            students: req.params.studentId
        });

        if (!defaultFeeStructure && specificFeeStructures.length === 0) {
            return res.json({
                totalFees: 0,
                paidAmount: 0,
                pendingAmount: 0,
                payments: [],
                message: 'Fee structure not found'
            });
        }

        // Aggregate Total Fees
        let totalFees = 0;
        let components = [];

        if (defaultFeeStructure) {
            totalFees += defaultFeeStructure.totalAmount;
            components = [...defaultFeeStructure.components];
        }

        specificFeeStructures.forEach(struct => {
            totalFees += struct.totalAmount;
            components = [...components, ...struct.components];
        });

        // Get Payments
        const payments = await FeePayment.find({
            student: req.params.studentId,
            academicYear: student.academicYear,
            status: 'success'
        }).sort({ paymentDate: -1 });

        const paidAmount = payments.reduce((sum, p) => sum + p.amount, 0);
        const pendingAmount = totalFees - paidAmount;

        res.json({
            feeStructure: {
                totalAmount: totalFees,
                components: components
            },
            totalFees,
            paidAmount,
            pendingAmount,
            payments
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/fees/analytics
// @desc    Get fee collection analytics
// @access  Admin/Super Admin
router.get('/analytics', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        // Simple analytics for now: Total Collected Today, This Month, Total Pending (Approx)

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        const [todayPayments, monthPayments, allPayments] = await Promise.all([
            // Collected Today
            StudentFee.aggregate([
                { $unwind: "$payments" },
                { $match: { "payments.date": { $gte: today } } },
                { $group: { _id: null, total: { $sum: '$payments.amount' } } }
            ]),
            // Collected This Month
            StudentFee.aggregate([
                { $unwind: "$payments" },
                { $match: { "payments.date": { $gte: firstDayOfMonth } } },
                { $group: { _id: null, total: { $sum: '$payments.amount' } } }
            ]),
            // Total Collected (All Time)
            StudentFee.aggregate([
                { $unwind: "$payments" },
                { $group: { _id: null, total: { $sum: '$payments.amount' } } }
            ])
        ]);

        res.json({
            collectedToday: todayPayments[0]?.total || 0,
            collectedThisMonth: monthPayments[0]?.total || 0,
            totalCollected: allPayments[0]?.total || 0
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
