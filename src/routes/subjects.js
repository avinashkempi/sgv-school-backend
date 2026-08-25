const express = require('express');
const router = express.Router();
const GlobalSubject = require('../models/GlobalSubject');
const Subject = require('../models/Subject');
const { authenticateToken: auth, checkRole } = require('../middleware/auth');

// @route   GET /api/subjects
// @desc    Get all global subjects
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        const subjects = await GlobalSubject.find().sort({ code: 1, name: 1 });
        res.json(subjects);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   POST /api/subjects
// @desc    Create a new global subject
// @access  Admin/Super Admin
router.post('/', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    const { name, code, type } = req.body;

    try {
        let subject = await GlobalSubject.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
        if (subject) {
            return res.status(400).json({ msg: 'Subject already exists' });
        }

        subject = new GlobalSubject({
            name,
            code,
            type
        });

        await subject.save();
        res.json(subject);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   PUT /api/subjects/:id
// @desc    Update a global subject
// @access  Admin/Super Admin
router.put('/:id', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    const { name, code, type } = req.body;

    try {
        let subject = await GlobalSubject.findById(req.params.id);
        if (!subject) return res.status(404).json({ msg: 'Subject not found' });

        // Check if name is taken by another subject
        if (name && name !== subject.name) {
            const existing = await GlobalSubject.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
            if (existing) {
                return res.status(400).json({ msg: 'Subject name already exists' });
            }
        }

        subject.name = name || subject.name;
        subject.code = code || subject.code;
        subject.type = type || subject.type;

        await subject.save();
        res.json(subject);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// @route   DELETE /api/subjects/:id
// @desc    Delete a global subject
// @access  Admin/Super Admin
router.delete('/:id', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const subject = await GlobalSubject.findById(req.params.id);
        if (!subject) return res.status(404).json({ msg: 'Subject not found' });

        // Check usage
        const usageCount = await Subject.countDocuments({ globalSubject: req.params.id });
        if (usageCount > 0) {
            console.warn(`Attempt to delete subject ${subject.name} which is used in ${usageCount} classes`);
            return res.status(400).json({ msg: `Cannot delete: Subject is used in ${usageCount} classes. Remove it from classes first.` });
        }

        await GlobalSubject.findByIdAndDelete(req.params.id);
        res.json({ msg: 'Subject deleted successfully' });
    } catch (err) {
        console.error('Error deleting subject:', err);
        res.status(500).json({ msg: 'Server Error during deletion', error: err.message });
    }
});

// @route   GET /api/subjects/:id/usage
// @desc    Get usage details for a global subject
// @access  Admin/Super Admin
// NOTE: This MUST come before GET /:id to ensure proper route matching
router.get('/:id/usage', [auth, checkRole(['admin', 'super admin'])], async (req, res) => {
    try {
        const usage = await Subject.find({ globalSubject: req.params.id })
            .populate('class', 'name section branch')
            .populate('teachers', 'name email profilePhoto')
            .sort({ 'class.name': 1 });

        res.json(usage);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'GlobalSubject not found' });
        }
        res.status(500).send('Server Error');
    }
});

// @route   GET /api/subjects/:id
// @desc    Get subject by ID
// @access  Private
// NOTE: This catch-all route must come LAST to avoid shadowing more specific routes
router.get('/:id', auth, async (req, res) => {
    try {
        // Validate that :id is a valid MongoDB ObjectId format to prevent casting errors
        if (!req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(404).json({ msg: 'Invalid subject ID format' });
        }

        const subject = await Subject.findById(req.params.id).populate('class', 'name section');
        if (!subject) {
            return res.status(404).json({ msg: 'Subject not found' });
        }
        res.json(subject);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(404).json({ msg: 'Subject not found' });
        }
        res.status(500).send('Server Error');
    }
});

module.exports = router;
