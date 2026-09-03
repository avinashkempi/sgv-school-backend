const express = require('express');
const router = express.Router();
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const FeePayment = require('../models/FeePayment');
const FeeStructure = require('../models/FeeStructure');
const StudentFee = require('../models/StudentFee');
const User = require('../models/User');
const { triggerNotification } = require('../controllers/notificationController');
const { isAdminRole, requireFeeReceiptAccess } = require('../middleware/accessControl');

// @route   GET /api/fee-enhancements/export-arrears/:academicYearId
// @desc    Export CSV of students with pending fees from a specific academic year
// @access  Admin/Super Admin
router.get('/export-arrears/:academicYearId', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const { academicYearId } = req.params;

        const students = await User.find({ role: 'student', academicYear: academicYearId })
            .populate('currentClass', 'name section')
            .lean();

        const defaulters = [];

        for (const student of students) {
            if (!student.currentClass) continue;

            let totalFees = 0;
            let paidAmount = 0;
            let pendingAmount = 0;

            // 1. Check for imported fee record (StudentFee) first
            const studentFee = await StudentFee.findOne({
                student: student._id,
                academicYear: academicYearId
            }).lean();

            if (studentFee) {
                totalFees = studentFee.toPay || studentFee.totalFees || 0;
                paidAmount = studentFee.totalPaid || 0;
                pendingAmount = studentFee.pendingAmount !== undefined ? studentFee.pendingAmount : Math.max(0, totalFees - paidAmount);
            } else {
                // 2. Fallback to FeeStructure and FeePayment
                const feeStructure = await FeeStructure.findOne({
                    class: student.currentClass._id,
                    academicYear: academicYearId,
                    type: 'class_default'
                });

                if (!feeStructure) continue;

                const payments = await FeePayment.find({
                    student: student._id,
                    academicYear: academicYearId,
                    status: 'success'
                }).lean();

                totalFees = feeStructure.totalAmount || 0;
                paidAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
                pendingAmount = Math.max(0, totalFees - paidAmount);
            }

            if (pendingAmount > 0) {
                defaulters.push({
                    rollNumber: student.rollNumber || student._id.toString().slice(-6),
                    name: student.name,
                    class: `${student.currentClass.name} ${student.currentClass.section || ''}`.trim(),
                    pendingAmount: pendingAmount
                });
            }
        }

        if (defaulters.length === 0) {
            return res.status(404).json({ success: false, message: 'No pending fee arrears found for this academic year.' });
        }

        // Generate CSV string
        const header = 'RollNumber,Name,OldClass,PendingAmount\n';
        const rows = defaulters.map(d => `${d.rollNumber},"${d.name}","${d.class}",${d.pendingAmount}`).join('\n');
        const csv = header + rows;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="fee_arrears_${academicYearId}.csv"`);
        res.status(200).send(csv);

    } catch (err) {
        console.error('Export Arrears Error:', err);
        res.status(500).json({ success: false, message: 'Server Error generating CSV', error: err.message });
    }
});

// @route   GET /api/fee-enhancements/defaulters
// @desc    Get list of students with pending fees
// @access  Admin/Super Admin
router.get('/defaulters', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const { classId, minAmount = 0 } = req.query;

        // Get all students
        let studentQuery = { role: 'student' };
        if (classId) studentQuery.currentClass = classId;

        const students = await User.find(studentQuery)
            .populate('currentClass', 'name section')
            .populate('academicYear', 'name')
            .lean();

        const defaulters = [];

        for (const student of students) {
            if (!student.currentClass || !student.academicYear) continue;

            let totalFees = 0;
            let paidAmount = 0;
            let pendingAmount = 0;
            let paymentSchedule = [];

            // 1. Check StudentFee first
            const studentFee = await StudentFee.findOne({
                student: student._id,
                academicYear: student.academicYear._id
            }).lean();

            const payments = await FeePayment.find({
                student: student._id,
                academicYear: student.academicYear._id,
                status: 'success'
            }).lean();

            const feeStructure = await FeeStructure.findOne({
                class: student.currentClass._id,
                academicYear: student.academicYear._id,
                type: 'class_default'
            }).lean();

            if (feeStructure?.paymentSchedule) {
                paymentSchedule = feeStructure.paymentSchedule;
            }

            if (studentFee) {
                totalFees = studentFee.toPay || studentFee.totalFees || 0;
                paidAmount = studentFee.totalPaid || 0;
                pendingAmount = studentFee.pendingAmount !== undefined ? studentFee.pendingAmount : Math.max(0, totalFees - paidAmount);
            } else if (feeStructure) {
                totalFees = feeStructure.totalAmount || 0;
                paidAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
                pendingAmount = Math.max(0, totalFees - paidAmount);
            } else {
                continue;
            }

            if (pendingAmount > parseFloat(minAmount)) {
                // Calculate fine if payment is overdue
                let fine = 0;
                const today = new Date();

                if (paymentSchedule.length > 0) {
                    paymentSchedule.forEach(schedule => {
                        const dueDate = new Date(schedule.dueDate);
                        if (dueDate < today) {
                            const monthsOverdue = Math.floor((today - dueDate) / (30 * 24 * 60 * 60 * 1000));
                            if (monthsOverdue > 0) {
                                fine += (schedule.amount * 0.01 * monthsOverdue);
                            }
                        }
                    });
                }

                defaulters.push({
                    student: {
                        _id: student._id,
                        name: student.name,
                        email: student.email,
                        phone: student.phone,
                        class: student.currentClass
                    },
                    fees: {
                        totalFees,
                        paidAmount,
                        pendingAmount,
                        fine: Math.round(fine),
                        totalDue: pendingAmount + Math.round(fine)
                    },
                    lastPaymentDate: payments.length > 0
                        ? payments.sort((a, b) => new Date(b.paymentDate) - new Date(a.paymentDate))[0].paymentDate
                        : (studentFee?.payments?.length > 0 ? studentFee.payments[studentFee.payments.length - 1].date : null)
                });
            }
        }

        // Sort by highest pending amount
        defaulters.sort((a, b) => b.fees.totalDue - a.fees.totalDue);

        res.json({
            success: true,
            defaulters,
            count: defaulters.length,
            totalPendingAmount: defaulters.reduce((sum, d) => sum + d.fees.pendingAmount, 0),
            totalFines: defaulters.reduce((sum, d) => sum + d.fees.fine, 0)
        });
    } catch (err) {
        console.error('Defaulters Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/fee-enhancements/collection-summary
// @desc    Get fee collection summary with date range
// @access  Admin/Super Admin
router.get('/collection-summary', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const { startDate, endDate, classId } = req.query;

        const matchQuery = { status: 'success' };

        if (startDate || endDate) {
            matchQuery.paymentDate = {};
            if (startDate) matchQuery.paymentDate.$gte = new Date(startDate);
            if (endDate) matchQuery.paymentDate.$lte = new Date(endDate);
        }

        if (classId) matchQuery.class = classId;

        // Aggregate by payment method
        const byMethod = await FeePayment.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: '$paymentMethod',
                    count: { $sum: 1 },
                    total: { $sum: '$amount' }
                }
            }
        ]);

        // Aggregate by day
        const byDay = await FeePayment.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$paymentDate' } },
                    count: { $sum: 1 },
                    total: { $sum: '$amount' }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Aggregate by class
        const byClass = await FeePayment.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: '$class',
                    count: { $sum: 1 },
                    total: { $sum: '$amount' }
                }
            },
            {
                $lookup: {
                    from: 'classes',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'classInfo'
                }
            },
            { $unwind: '$classInfo' },
            {
                $project: {
                    className: { $concat: ['$classInfo.name', ' ', '$classInfo.section'] },
                    count: 1,
                    total: 1
                }
            }
        ]);

        // Total collected
        const totalStats = await FeePayment.aggregate([
            { $match: matchQuery },
            {
                $group: {
                    _id: null,
                    totalAmount: { $sum: '$amount' },
                    totalCount: { $sum: 1 }
                }
            }
        ]);

        res.json({
            success: true,
            summary: {
                totalAmount: totalStats[0]?.totalAmount || 0,
                totalTransactions: totalStats[0]?.totalCount || 0,
                byPaymentMethod: byMethod,
                byDay,
                byClass
            }
        });
    } catch (err) {
        console.error('Collection Summary Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   POST /api/fee-enhancements/send-reminders
// @desc    Send fee payment reminders to students
// @access  Admin/Super Admin
router.post('/send-reminders', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const { classId, minPendingAmount = 100 } = req.body;

        // Get all students with pending fees
        let studentQuery = { role: 'student' };
        if (classId) studentQuery.currentClass = classId;

        const students = await User.find(studentQuery).lean();

        let remindersSent = 0;

        for (const student of students) {
            if (!student.currentClass || !student.academicYear) continue;

            let totalFees = 0;
            let paidAmount = 0;
            let pendingAmount = 0;

            const studentFee = await StudentFee.findOne({
                student: student._id,
                academicYear: student.academicYear
            }).lean();

            if (studentFee) {
                totalFees = studentFee.toPay || studentFee.totalFees || 0;
                paidAmount = studentFee.totalPaid || 0;
                pendingAmount = studentFee.pendingAmount !== undefined ? studentFee.pendingAmount : Math.max(0, totalFees - paidAmount);
            } else {
                const feeStructure = await FeeStructure.findOne({
                    class: student.currentClass,
                    academicYear: student.academicYear,
                    type: 'class_default'
                });

                if (!feeStructure) continue;

                const payments = await FeePayment.find({
                    student: student._id,
                    academicYear: student.academicYear,
                    status: 'success'
                }).lean();

                totalFees = feeStructure.totalAmount || 0;
                paidAmount = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
                pendingAmount = Math.max(0, totalFees - paidAmount);
            }

            if (pendingAmount >= minPendingAmount) {
                // Send notification
                await triggerNotification({
                    title: '💰 Fee Payment Reminder',
                    message: `You have an outstanding fee of ₹${pendingAmount.toLocaleString()}. Please clear your dues at the earliest to avoid any inconvenience.`,
                    category: 'fee',
                    priority: pendingAmount > 5000 ? 'high' : 'medium',
                    target: 'user',
                    targetId: student._id,
                    actionType: 'navigate',
                    actionData: '/student/fees'
                });

                remindersSent++;
            }
        }

        res.json({
            success: true,
            message: `Reminders sent to ${remindersSent} students`,
            count: remindersSent
        });
    } catch (err) {
        console.error('Send Reminders Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/fee-enhancements/installments/:studentId
// @desc    Get installment status for a student
// @access  Private
router.get('/installments/:studentId', auth, async (req, res) => {
    try {
        const { studentId } = req.params;
        if (!isAdminRole(req.user.role) && !(req.user.role === 'student' && req.user.userId === studentId)) {
            return res.status(403).json({ success: false, message: 'Not authorized' });
        }

        const student = await User.findById(studentId).lean();
        if (!student) {
            return res.status(404).json({ success: false, message: 'Student not found' });
        }

        // Get fee structure
        const feeStructure = await FeeStructure.findOne({
            class: student.currentClass,
            academicYear: student.academicYear,
            type: 'class_default'
        }).lean();

        if (!feeStructure || !feeStructure.paymentSchedule || feeStructure.paymentSchedule.length === 0) {
            return res.json({
                success: true,
                installments: [],
                message: 'No installment schedule found'
            });
        }

        // Check for imported fee record first
        const studentFee = await StudentFee.findOne({
            student: studentId,
            academicYear: student.academicYear
        }).lean();

        // Get payments
        const payments = await FeePayment.find({
            student: studentId,
            academicYear: student.academicYear,
            status: 'success'
        }).sort({ paymentDate: 1 }).lean();

        let totalPaid = 0;
        if (studentFee && studentFee.totalPaid !== undefined) {
            totalPaid = studentFee.totalPaid;
        } else {
            totalPaid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
        }

        let remainingPaidToAllocate = totalPaid;
        const installments = feeStructure.paymentSchedule.map((schedule, index) => {
            const installmentAmount = schedule.amount || 0;
            const dueDate = schedule.dueDate ? new Date(schedule.dueDate) : null;
            const today = new Date();

            // Correctly allocate remaining paid amount without mutating totalPaid in loop
            const paidForThis = Math.min(Math.max(0, remainingPaidToAllocate), installmentAmount);
            remainingPaidToAllocate -= paidForThis;

            const status = paidForThis >= installmentAmount ? 'paid' :
                (dueDate && dueDate < today) ? 'overdue' : (paidForThis > 0 ? 'partial' : 'pending');

            return {
                installmentNumber: schedule.installmentNumber || index + 1,
                amount: installmentAmount,
                dueDate: schedule.dueDate,
                label: schedule.label || schedule.description || `Installment ${index + 1}`,
                paidAmount: paidForThis,
                pendingAmount: Math.max(0, installmentAmount - paidForThis),
                status,
                isOverdue: status === 'overdue'
            };
        });

        res.json({
            success: true,
            installments,
            totalInstallments: installments.length,
            paidInstallments: installments.filter(i => i.status === 'paid').length,
            overdueInstallments: installments.filter(i => i.status === 'overdue').length
        });
    } catch (err) {
        console.error('Installments Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

// @route   GET /api/fee-enhancements/receipt/:paymentId
// @desc    Get receipt data for PDF generation
// @access  Private
router.get('/receipt/:paymentId', [auth, requireFeeReceiptAccess], async (req, res) => {
    try {
        const payment = req.payment;

        res.json({
            success: true,
            receipt: {
                receiptNumber: payment.receiptNumber,
                paymentDate: payment.paymentDate,
                student: payment.student,
                class: payment.class,
                academicYear: payment.academicYear,
                amount: payment.amount,
                paymentMethod: payment.paymentMethod,
                transactionId: payment.transactionId,
                collectedBy: payment.collectedBy,
                remarks: payment.remarks
            }
        });
    } catch (err) {
        console.error('Receipt Error:', err);
        res.status(500).json({ success: false, message: 'Server Error', error: err.message });
    }
});

module.exports = router;
