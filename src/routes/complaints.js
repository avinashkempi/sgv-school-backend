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
            if (visibility === 'teacher') {
                complaintData.visibility = 'teacher';

                // Find class teacher
                const student = await User.findById(userId).populate('currentClass');
                if (student.currentClass && student.currentClass.classTeacher) {
                    complaintData.assignedTo = student.currentClass.classTeacher;
                } else {
                    // Fallback if no class teacher assigned, maybe go to admin?
                    // For now, let's keep it as teacher visibility but unassigned, or default to admin
                    complaintData.visibility = 'admin'; // Fallback
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
// @desc    Get complaints visible to the logged-in user (Teacher/Admin)
// @access  Private (Teacher/Admin/Super Admin)
router.get('/inbox', [auth, checkRole(['teacher', 'admin', 'super admin'])], async (req, res) => {
    try {
        const { role, userId } = req.user;
        let filter = {};

        if (role === 'teacher') {
            // Teacher sees complaints assigned to them (visibility: teacher)
            filter = {
                visibility: 'teacher',
                assignedTo: userId
            };
        } else if (role === 'admin') {
            // Admin sees 'admin' visibility (Student -> Headmaster)
            // And maybe 'teacher' visibility for oversight?
            filter = {
                $or: [
                    { visibility: 'admin' },
                    { visibility: 'teacher' }
                ]
            };
        } else if (role === 'super admin') {
            // Super Admin sees everything, including Teacher -> Management
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
// @access  Private (Teacher/Admin/Super Admin)
router.put('/:id/status', [auth, checkRole(['teacher', 'admin', 'super admin'])], async (req, res) => {
    try {
        const { status, adminResponse } = req.body;
        const { role, userId } = req.user;

        let complaint = await Complaint.findById(req.params.id);
        if (!complaint) {
            return res.status(404).json({ message: 'Complaint not found' });
        }

        // Authorization check
        if (role === 'teacher') {
            if (complaint.visibility !== 'teacher' || complaint.assignedTo?.toString() !== userId) {
                return res.status(403).json({ message: 'Not authorized to update this complaint' });
            }
        }
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
