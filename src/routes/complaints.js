const express = require('express');
const router = express.Router();
const { authenticateToken: auth, checkRole } = require('../middleware/auth');
const Complaint = require('../models/Complaint');
const User = require('../models/User');
const _Class = require('../models/Class');

// @route   POST /api/complaints
// @desc    Create a new complaint
// @access  Private (Student/Teacher)
router.post('/', auth, async (req, res) => {
    try {
        const { category, title, description, priority, visibility } = req.body;
        const userRole = req.user.role;
        const userId = req.user.userId;

        let complaintData = {
            raisedBy: userId,
            role: userRole,
            category,
            title,
            description,
            priority: priority || 'Medium',
            student: userId // For backward compatibility
        };

        if (userRole === 'student') {
            // Student can raise to Teacher or Headmaster (Admin)
            // UPDATE: Strict segregation - Teachers have no inbox.
            // All Student complaints go to Admin (Headmaster).
            if (visibility === 'teacher') {
                // Force to admin as teacher can't see inbox
                complaintData.visibility = 'admin';

                // Still try to assign class teacher for record, even if they can't see it in inbox
                const student = await User.findById(userId).populate('currentClass');
                if (student.currentClass && student.currentClass.classTeacher) {
                    complaintData.assignedTo = student.currentClass.classTeacher;
                }
            } else {
                // Default to Admin (Headmaster)
                complaintData.visibility = 'admin';
            }
        } else if (userRole === 'teacher') {
            // Teacher raises to Management (Super Admin)
            complaintData.visibility = 'super_admin';
            complaintData.category = 'Management'; // Force category or allow selection?
        } else {
            // Admin/Super Admin?
            complaintData.visibility = 'super_admin';
        }

        const complaint = new Complaint(complaintData);
        await complaint.save();
        res.json(complaint);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/complaints/my-complaints
// @desc    Get complaints raised by logged-in user
// @access  Private
router.get('/my-complaints', auth, async (req, res) => {
    try {
        const complaints = await Complaint.find({ raisedBy: req.user.userId })
            .sort({ createdAt: -1 });
        res.json(complaints);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/complaints/inbox
// @desc    Get complaints visible to the logged-in user (Admin/Super Admin)
// @access  Private (Admin/Super Admin)
router.get('/inbox', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const { role, userId } = req.user;
        let filter = {};

        if (role === 'admin') {
            // Admin (Headmaster) sees 'admin' visibility (Student -> Headmaster)
            filter = { visibility: 'admin' };
        } else if (role === 'super admin') {
            // Super Admin (Management) sees EVERYTHING (Student + Teacher)
            filter = {};
        }

        const complaints = await Complaint.find(filter)
            .populate('raisedBy', 'name email role currentClass')
            .populate('assignedTo', 'name')
            .sort({ createdAt: -1 });

        res.json(complaints);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/complaints/:id/status
// @desc    Update complaint status
// @access  Private (Admin/Super Admin)
router.put('/:id/status', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const { status, adminResponse } = req.body;
        const { role, userId } = req.user;

        // Validate ObjectId format
        if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ message: 'Invalid complaint ID format' });
        }

        let complaint = await Complaint.findById(req.params.id);
        if (!complaint) {
            return res.status(404).json({ message: 'Complaint not found' });
        }

        // Authorization check
        // Admin/Super Admin can update mostly anything, maybe restrict Admin from 'super_admin' visibility?
        if (role === 'admin' && complaint.visibility === 'super_admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }

        complaint.status = status;
        if (adminResponse) complaint.adminResponse = adminResponse;

        if (status === 'Resolved' || status === 'Rejected') {
            complaint.resolvedAt = Date.now();
            complaint.resolvedBy = userId;
        }

        complaint.updatedAt = Date.now();
        await complaint.save();

        res.json(complaint);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

module.exports = router;
