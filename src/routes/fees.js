const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const { yearContext, requireOpenYear } = require('../middleware/yearContext');
const FeeStructure = require('../models/FeeStructure');
const FeePayment = require('../models/FeePayment');
const Counter = require('../models/Counter');
const StudentFee = require('../models/StudentFee');
const User = require('../models/User');
const Class = require('../models/Class');
const { sendTargetedNotification } = require('../services/notificationService');
const { isAdminRole } = require('../middleware/accessControl');
const { invalidateDashboardCaches, invalidateAdminDashboard, invalidateStudentDashboard, invalidateMultipleStudentDashboards } = require('../controllers/dashboardController');

// Helper to generate receipt number atomically.
const generateReceiptNumber = async () => {
    const date = new Date();
    const year = date.getFullYear().toString().substr(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const prefix = `RCP${year}${month}`;

    const counter = await Counter.findOneAndUpdate(
        { key: `receipt:${prefix}` },
        { $inc: { seq: 1 }, $set: { updatedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return `${prefix}${counter.seq.toString().padStart(4, '0')}`;
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

        // Invalidate dashboard caches (admin stats + affected students only)
        invalidateAdminDashboard().catch(() => {});
        if (type === 'student_specific' && students && students.length > 0) {
            invalidateMultipleStudentDashboards(students).catch(() => {});
        } else if (type === 'class_default' && classId) {
            User.find({ role: 'student', currentClass: classId }).select('_id').lean()
                .then(stus => invalidateMultipleStudentDashboards(stus.map(s => s._id)))
                .catch(() => {});
        }

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
            amount: Number(amount),
            paymentMethod,
            transactionId,
            receiptNumber,
            bookNumber,
            manualReceiptNumber,
            remarks,
            collectedBy: req.user.userId
        });

        await payment.save();

        // Also update/sync with StudentFee record if it exists
        const studentFee = await StudentFee.findOne({
            student: studentId,
            academicYear: academicYearId
        });

        if (studentFee) {
            studentFee.payments.push({
                amount: Number(amount),
                date: new Date(),
                invoiceNumber: receiptNumber,
                installmentNumber: (studentFee.payments?.length || 0) + 1,
                paymentMode: paymentMethod === 'cash' ? 'Cash' : (paymentMethod === 'online' || paymentMethod === 'upi' ? 'UPI' : (paymentMethod || 'Cash')),
                remarks: remarks
            });
            studentFee.totalPaid = (studentFee.totalPaid || 0) + Number(amount);
            const toPay = studentFee.toPay || Math.max(0, (studentFee.totalFees || 0) + (studentFee.arrears || 0) - (studentFee.concession || 0));
            studentFee.toPay = toPay;
            studentFee.pendingAmount = Math.max(0, toPay - studentFee.totalPaid);
            studentFee.updatedAt = new Date();
            await studentFee.save();
        }

        // Notify Student
        await sendTargetedNotification('user', studentId, {
            title: 'Fee Payment Successful',
            message: `Payment of ${amount} received. Receipt: ${receiptNumber}`,
            type: 'Fee'
        });

        // Invalidate admin dashboard and this specific student's dashboard
        invalidateAdminDashboard().catch(() => {});
        invalidateStudentDashboard(studentId).catch(() => {});

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
            .select('name phone email currentClass regNo profilePhoto')
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
            let concession = 0;
            let toPay = 0;

            if (feeRecord) {
                totalFees = feeRecord.totalFees || 0;
                paidAmount = feeRecord.totalPaid || 0;
                pendingAmount = feeRecord.pendingAmount || 0;
                concession = feeRecord.concession || 0;
                toPay = feeRecord.toPay || Math.max(0, totalFees + (feeRecord.arrears || 0) - concession);
            }

            return {
                _id: student._id,
                name: student.name,
                profilePhoto: student.profilePhoto,
                admissionNo: student.admissionNo,
                rollNo: student.rollNo,
                className: student.currentClass?.name || 'N/A',
                section: student.currentClass?.section || '',
                currentClassId: student.currentClass?._id,
                totalFees,
                toPay,
                concession,
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
        // Fee records are sensitive: only admins/super admins or the owning student may read them.
        if (!isAdminRole(req.user.role) && !(req.user.role === 'student' && req.user.userId === req.params.studentId)) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const academicYearId = req.academicYearContext;

        const student = await User.findById(req.params.studentId);
        if (!student) return res.status(404).json({ message: 'Student not found' });

        // Fetch Fee Structure for payment schedule comparison
        const defaultFeeStructure = await FeeStructure.findOne({
            class: student.currentClass,
            academicYear: academicYearId,
            type: 'class_default'
        });

        // CHECK FOR IMPORTED FEE RECORD FIRST (StudentFee)
        // This is the source of truth for imported data
        const StudentFee = require('../models/StudentFee');
        const studentFee = await StudentFee.findOne({
            student: req.params.studentId,
            academicYear: academicYearId
        });

        const computeInstallmentSchedule = (totalPaidAmount, structure) => {
            if (!structure?.paymentSchedule || structure.paymentSchedule.length === 0) {
                return [];
            }
            const now = new Date();
            let runningTarget = 0;

            return structure.paymentSchedule.map((inst, idx) => {
                runningTarget += (inst.amount || 0);
                let status = 'upcoming';
                let paidForInst = 0;

                if (totalPaidAmount >= runningTarget) {
                    status = 'paid';
                    paidForInst = inst.amount || 0;
                } else if (totalPaidAmount > (runningTarget - (inst.amount || 0))) {
                    status = 'partial';
                    paidForInst = totalPaidAmount - (runningTarget - (inst.amount || 0));
                } else {
                    if (inst.dueDate && new Date(inst.dueDate) < now) {
                        status = 'overdue';
                    } else if (inst.dueDate && (new Date(inst.dueDate).getTime() - now.getTime()) < 14 * 24 * 60 * 60 * 1000) {
                        status = 'due_soon';
                    } else {
                        status = 'upcoming';
                    }
                }

                return {
                    installmentNumber: inst.installmentNumber || idx + 1,
                    description: inst.description || `Installment ${inst.installmentNumber || idx + 1}`,
                    amount: inst.amount || 0,
                    dueDate: inst.dueDate,
                    paidAmount: paidForInst,
                    status
                };
            });
        };

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

            const toPay = studentFee.toPay || Math.max(0, (studentFee.totalFees || 0) + (studentFee.arrears || 0) - (studentFee.concession || 0));
            const installmentSchedule = computeInstallmentSchedule(studentFee.totalPaid || 0, defaultFeeStructure);

            return res.json({
                feeStructure: {
                    totalAmount: studentFee.totalFees,
                    components: defaultFeeStructure?.components?.length > 0 ? defaultFeeStructure.components : [
                        { name: "Tuition & Other Fees", amount: studentFee.totalFees }
                    ],
                    paymentSchedule: defaultFeeStructure?.paymentSchedule || []
                },
                totalFees: studentFee.totalFees,
                toPay: toPay,
                paidAmount: studentFee.totalPaid,
                pendingAmount: studentFee.pendingAmount,
                concession: studentFee.concession || 0,
                arrears: studentFee.arrears || 0,
                payments: mappedPayments,
                installmentSchedule: installmentSchedule
            });
        }

        // --- FALLBACK TO LEGACY/CALCULATED LOGIC ---

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
                toPay: 0,
                paidAmount: 0,
                pendingAmount: 0,
                concession: 0,
                arrears: 0,
                payments: [],
                installmentSchedule: [],
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
        const pendingAmount = Math.max(0, totalFees - paidAmount);
        const installmentSchedule = computeInstallmentSchedule(paidAmount, defaultFeeStructure);

        res.json({
            feeStructure: {
                totalAmount: totalFees,
                components: components,
                paymentSchedule: defaultFeeStructure?.paymentSchedule || []
            },
            totalFees,
            toPay: totalFees,
            paidAmount,
            pendingAmount,
            concession: 0,
            arrears: 0,
            payments,
            installmentSchedule
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/fees/analytics
// @desc    Get fee collection analytics (Scoped to Academic Year Context) with single $facet query
// @access  Admin/Super Admin
router.get('/analytics', [auth, checkRole(['admin', 'super admin']), yearContext], async (req, res) => {
    try {
        const academicYearId = new mongoose.Types.ObjectId(req.academicYearContext);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

        const aggregationResult = await StudentFee.aggregate([
            { $match: { academicYear: academicYearId } },
            {
                $facet: {
                    todayPayments: [
                        { $unwind: "$payments" },
                        { $match: { "payments.date": { $gte: today } } },
                        { $group: { _id: null, total: { $sum: '$payments.amount' } } }
                    ],
                    monthPayments: [
                        { $unwind: "$payments" },
                        { $match: { "payments.date": { $gte: firstDayOfMonth } } },
                        { $group: { _id: null, total: { $sum: '$payments.amount' } } }
                    ],
                    globalStats: [
                        {
                            $group: {
                                _id: null,
                                totalCollected: { $sum: '$totalPaid' },
                                totalPending: { $sum: '$pendingAmount' },
                                totalArrears: { $sum: '$arrears' },
                                totalConcession: { $sum: '$concession' },
                                totalGrossFees: { $sum: '$totalFees' },
                                totalExpectedFees: {
                                    $sum: {
                                        $subtract: [
                                            { $add: [{ $ifNull: ['$totalFees', 0] }, { $ifNull: ['$arrears', 0] }] },
                                            { $ifNull: ['$concession', 0] }
                                        ]
                                    }
                                },
                                totalStudents: { $sum: 1 }
                            }
                        }
                    ],
                    classBreakdown: [
                        {
                            $group: {
                                _id: "$class",
                                totalFees: { $sum: "$totalFees" },
                                totalConcession: { $sum: "$concession" },
                                totalArrears: { $sum: "$arrears" },
                                totalExpected: {
                                    $sum: {
                                        $subtract: [
                                            { $add: [{ $ifNull: ["$totalFees", 0] }, { $ifNull: ["$arrears", 0] }] },
                                            { $ifNull: ["$concession", 0] }
                                        ]
                                    }
                                },
                                totalPaid: { $sum: "$totalPaid" },
                                totalPending: { $sum: "$pendingAmount" },
                                studentCount: { $sum: 1 }
                            }
                        },
                        {
                            $lookup: {
                                from: "classes",
                                localField: "_id",
                                foreignField: "_id",
                                as: "classInfo"
                            }
                        },
                        { $unwind: { path: "$classInfo", preserveNullAndEmptyArrays: true } },
                        {
                            $project: {
                                classId: "$_id",
                                className: { $ifNull: ["$classInfo.name", "Unassigned"] },
                                section: { $ifNull: ["$classInfo.section", ""] },
                                totalFees: 1,
                                totalExpected: 1,
                                totalPaid: 1,
                                totalPending: 1,
                                totalConcession: 1,
                                totalArrears: 1,
                                studentCount: 1,
                                collectionRate: {
                                    $cond: [
                                        { $gt: ["$totalExpected", 0] },
                                        { $round: [{ $multiply: [{ $divide: ["$totalPaid", "$totalExpected"] }, 100] }, 1] },
                                        0
                                    ]
                                }
                            }
                        },
                        { $sort: { className: 1, section: 1 } }
                    ]
                }
            }
        ]);

        const facet = aggregationResult[0] || {};
        const stats = facet.globalStats?.[0] || {};
        const todayTotal = facet.todayPayments?.[0]?.total || 0;
        const monthTotal = facet.monthPayments?.[0]?.total || 0;
        const classBreakdown = facet.classBreakdown || [];

        const totalExpectedFees = stats.totalExpectedFees !== undefined
            ? stats.totalExpectedFees
            : ((stats.totalGrossFees || 0) + (stats.totalArrears || 0) - (stats.totalConcession || 0));

        res.json({
            collectedToday: todayTotal,
            collectedThisMonth: monthTotal,
            totalCollected: stats.totalCollected || 0,
            totalPending: stats.totalPending || 0,
            totalArrears: stats.totalArrears || 0,
            totalConcession: stats.totalConcession || 0,
            totalGrossFees: stats.totalGrossFees || 0,
            totalExpectedFees: totalExpectedFees,
            totalStudents: stats.totalStudents || 0,
            classBreakdown: classBreakdown
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
