const express = require('express');
const router = express.Router();
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');
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
router.post('/structure', [auth, checkRole(['admin', 'super admin']), yearContext, requireOpenYear], async (req, res) => {
    try {

        const { classId, components, paymentSchedule, type, students } = req.body;

        // Securely pull the year from the context header instead of trusting the client body
        const academicYearId = req.academicYearContext;

        if (!classId || !academicYearId) {
            return res.status(400).json({ message: "Class and Academic Year Context are required" });
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
// @desc    Get fee structure for a class (current academic year context)
// @access  Private
router.get('/structure/class/:classId', [auth, yearContext], async (req, res) => {
    try {
        const academicYearId = req.academicYearContext;

        const classData = await Class.findById(req.params.classId);
        if (!classData) return res.status(404).json({ message: 'Class not found' });

        let feeStructure;
        feeStructure = await FeeStructure.findOne({
            class: req.params.classId,
            academicYear: academicYearId,
            type: 'class_default'
        });

        // If not found by specific academic year, fallback for backward compatibility
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
router.post('/payment', [auth, checkRole(['admin', 'super admin']), yearContext, requireOpenYear], async (req, res) => {
    try {
        const { studentId, amount, paymentMethod, transactionId, remarks, bookNumber, manualReceiptNumber } = req.body;

        const academicYearId = req.academicYearContext;

        const student = await User.findById(studentId);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        if (!student.currentClass) {
            return res.status(400).json({ message: 'Student not assigned to a class' });
        }

        const feeStructure = await FeeStructure.findOne({
            class: student.currentClass,
            academicYear: academicYearId,
            type: 'class_default'
        });

        // Also check for specific structures
        const specificStructures = await FeeStructure.find({
            class: student.currentClass,
            academicYear: academicYearId,
            type: 'student_specific',
            students: studentId
        });

        if (!feeStructure && specificStructures.length === 0) {
            return res.status(400).json({ message: 'Fee structure not defined for this student\'s class in current year context' });
        }

        const receiptNumber = await generateReceiptNumber();

        const payment = new FeePayment({
            student: studentId,
            class: student.currentClass,
            academicYear: academicYearId,
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

// @route   GET /api/fees/summary
// @desc    Get fee summary for all students (for list view)
// @access  Admin/Super Admin
router.get('/summary', [auth, checkRole(['admin', 'super admin']), yearContext], async (req, res) => {
    try {
        const { classId } = req.query;
        const academicYearId = req.academicYearContext;

        // 1. Build User Query
        const query = { role: 'student' };
        if (academicYearId) query.academicYear = academicYearId;
        if (classId) query.currentClass = classId;

        // 2. Fetch All Students (Lite)
        const students = await User.find(query)
            .select('name phone currentClass admissionNo rollNo')
            .populate('currentClass', 'name section')
            .lean();

        // 3. Fetch Fee Data (StudentFee) - This is the source of truth for imported data
        // We fetching ALL StudentFee records for this year to map them in memory
        // optimizing to avoid N+1 queries
        const feeQuery = {};
        if (academicYearId) feeQuery.academicYear = academicYearId;

        const allFeeRecords = await StudentFee.find(feeQuery).lean();

        // Create a map for quick lookup: studentId -> feeRecord
        const feeMap = {};
        allFeeRecords.forEach(record => {
            feeMap[record.student.toString()] = record;
        });

        // 4. Merge Data
        const summary = students.map(student => {
            const feeRecord = feeMap[student._id.toString()];

            let totalFees = 0;
            let paidAmount = 0;
            let pendingAmount = 0;

            if (feeRecord) {
                totalFees = feeRecord.totalFees;
                paidAmount = feeRecord.totalPaid;
                pendingAmount = feeRecord.pendingAmount;
            } else {
                // Fallback: If no StudentFee record, usually means no fee assigned or data not imported yet.
                // We could try to calculate from FeeStructure/FeePayment but that's heavy. 
                // For the summary list, we'll default to 0 to keep it fast.
                // Detailed calculation happens when clicking on a student.
            }

            return {
                _id: student._id,
                name: student.name,
                admissionNo: student.admissionNo,
                rollNo: student.rollNo,
                className: student.currentClass?.name || 'N/A',
                section: student.currentClass?.section || '',
                currentClassId: student.currentClass?._id,
                totalFees,
                paidAmount,
                pendingAmount
            };
        });

        // 5. Respond
        res.json(summary);

    } catch (err) {
        console.error("Error in GET /fees/summary:", err);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/fees/student/:studentId
// @desc    Get student fee status and history
// @access  Private (Admin, or Student for own data)
router.get('/student/:studentId', [auth, yearContext], async (req, res) => {
    try {
        // Authorization check
        if (req.user.role === 'student' && req.user.userId !== req.params.studentId) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const academicYearId = req.academicYearContext;

        const student = await User.findById(req.params.studentId);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        // CHECK FOR IMPORTED FEE RECORD FIRST (StudentFee)
        // This is the source of truth for imported data
        const StudentFee = require('../models/StudentFee');
        const studentFee = await StudentFee.findOne({
            student: req.params.studentId,
            academicYear: academicYearId
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
            academicYear: academicYearId,
            type: 'class_default'
        });

        // Get Specific Fee Structures
        const specificFeeStructures = await FeeStructure.find({
            class: student.currentClass,
            academicYear: academicYearId,
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
            academicYear: academicYearId,
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
// @desc    Get fee collection analytics (Scroped to Academic Year Context)
// @access  Admin/Super Admin
router.get('/analytics', [auth, checkRole(['admin', 'super admin']), yearContext], async (req, res) => {
    try {
        const academicYearId = req.academicYearContext;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        const [todayPayments, monthPayments, allCollected] = await Promise.all([
            // Collected Today (from payments array — needs date filter)
            StudentFee.aggregate([
                { $match: { academicYear: req.academicYearContext } },
                { $unwind: "$payments" },
                { $match: { "payments.date": { $gte: today } } },
                { $group: { _id: null, total: { $sum: '$payments.amount' } } }
            ]),
            // Collected This Month (from payments array — needs date filter)
            StudentFee.aggregate([
                { $match: { academicYear: req.academicYearContext } },
                { $unwind: "$payments" },
                { $match: { "payments.date": { $gte: firstDayOfMonth } } },
                { $group: { _id: null, total: { $sum: '$payments.amount' } } }
            ]),
            // Total Collected — use totalPaid field (works for both CSV-imported and app payments)
            StudentFee.aggregate([
                { $match: { academicYear: req.academicYearContext } },
                { $group: { _id: null, total: { $sum: '$totalPaid' } } }
            ])
        ]);

        res.json({
            collectedToday: todayPayments[0]?.total || 0,
            collectedThisMonth: monthPayments[0]?.total || 0,
            totalCollected: allCollected[0]?.total || 0
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
