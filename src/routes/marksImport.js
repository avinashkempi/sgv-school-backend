const express = require('express');
const router = express.Router();
const Marks = require('../models/Marks');
const Exam = require('../models/Exam');
const User = require('../models/User');
const auth = require('../middleware/auth');

/**
 * CSV Import Route
 * @route POST /api/marks/import/csv
 * @desc Import marks from CSV file
 * @access Private (Teacher/Admin)
 */
router.post('/import/csv', auth, async (req, res) => {
    try {
        const { examId, csvData } = req.body;

        // Verify exam exists and user has access
        const exam = await Exam.findById(examId).populate('class subject');
        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Check authorization
        const isTeacher = req.user.role === 'teacher' && exam.createdBy.toString() === req.user.id;
        const isAdmin = req.user.role === 'admin' || req.user.role === 'super-admin';

        if (!isTeacher && !isAdmin) {
            return res.status(403).json({ message: 'Not authorized to import marks for this exam' });
        }

        // Parse CSV data
        // Expected format: studentId/email/name, marksObtained, remarks (optional)
        const results = {
            imported: 0,
            updated: 0,
            failed: 0,
            errors: []
        };

        for (let i = 0; i < csvData.length; i++) {
            const row = csvData[i];

            try {
                // Find student by ID, email, or name
                let student;
                if (row.studentId) {
                    student = await User.findById(row.studentId);
                } else if (row.email) {
                    student = await User.findOne({ email: row.email, role: 'student' });
                } else if (row.name) {
                    student = await User.findOne({
                        name: { $regex: new RegExp(row.name, 'i') },
                        role: 'student',
                        currentClass: exam.class._id
                    });
                }

                if (!student) {
                    results.errors.push({
                        row: i + 1,
                        data: row,
                        error: 'Student not found'
                    });
                    results.failed++;
                    continue;
                }

                // Validate marks
                const marksObtained = parseFloat(row.marksObtained);
                if (isNaN(marksObtained) || marksObtained < 0 || marksObtained > exam.totalMarks) {
                    results.errors.push({
                        row: i + 1,
                        student: student.name,
                        error: `Invalid marks: ${row.marksObtained}. Must be between 0 and ${exam.totalMarks}`
                    });
                    results.failed++;
                    continue;
                }

                // Calculate percentage and grade
                const percentage = (marksObtained / exam.totalMarks) * 100;
                const grade = calculateGrade(percentage);

                // Check if marks already exist
                const existingMark = await Marks.findOne({
                    student: student._id,
                    exam: examId
                });

                if (existingMark) {
                    // Update existing marks
                    existingMark.marksObtained = marksObtained;
                    existingMark.percentage = percentage;
                    existingMark.grade = grade;
                    existingMark.remarks = row.remarks || existingMark.remarks;
                    existingMark.enteredBy = req.user.id;
                    existingMark.updatedAt = Date.now();
                    await existingMark.save();
                    results.updated++;
                } else {
                    // Create new marks entry
                    await Marks.create({
                        student: student._id,
                        exam: examId,
                        marksObtained,
                        percentage,
                        grade,
                        remarks: row.remarks || '',
                        enteredBy: req.user.id
                    });
                    results.imported++;
                }
            } catch (error) {
                results.errors.push({
                    row: i + 1,
                    data: row,
                    error: error.message
                });
                results.failed++;
            }
        }

        res.json({
            message: `Import completed: ${results.imported} created, ${results.updated} updated, ${results.failed} failed`,
            results
        });
    } catch (error) {
        console.error('CSV Import Error:', error);
        res.status(500).json({ message: 'Server error during CSV import', error: error.message });
    }
});

/**
 * Helper function to calculate grade
 */
function calculateGrade(percentage) {
    if (percentage >= 90) return 'A+';
    if (percentage >= 80) return 'A';
    if (percentage >= 70) return 'B+';
    if (percentage >= 60) return 'B';
    if (percentage >= 50) return 'C';
    if (percentage >= 40) return 'D';
    return 'F';
}

/**
 * Get CSV Template
 * @route GET /api/marks/import/template/:examId
 * @desc Download CSV template for marks import
 * @access Private (Teacher/Admin)
 */
router.get('/import/template/:examId', auth, async (req, res) => {
    try {
        const exam = await Exam.findById(req.params.examId).populate('class');
        if (!exam) {
            return res.status(404).json({ message: 'Exam not found' });
        }

        // Get students in the class
        const students = await User.find({
            currentClass: exam.class._id,
            role: 'student'
        }).select('name email').sort({ name: 1 });

        // Generate CSV template
        let csv = 'Student Name,Email,Student ID,Marks Obtained,Remarks\n';
        students.forEach(student => {
            csv += `${student.name},${student.email},${student._id},,\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="marks_template_${exam.name.replace(/\s+/g, '_')}.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('Template Error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

module.exports = router;
