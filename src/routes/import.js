const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const { processImport } = require('../services/importService');
const { requireFinanceAccess } = require('../middleware/auth');

// Setup multer for file upload
const upload = multer({ dest: 'uploads/' });

/**
 * @route POST /api/import/students/csv
 * @desc Import students from CSV file
 * @access Private (Admin/Super Admin)
 */
router.post('/students/csv', requireFinanceAccess, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
    }

    const wipeData = req.body.wipe === 'true'; // Check if wipe is requested
    const results = [];

    try {
        // Parse CSV file
        fs.createReadStream(req.file.path)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', async () => {
                try {
                    // Process the imported data
                    const importResult = await processImport(results, { wipe: wipeData });

                    // Clean up uploaded file
                    fs.unlinkSync(req.file.path);

                    res.json({
                        message: 'Import processed successfully',
                        data: importResult
                    });
                } catch (error) {
                    console.error('Import processing error:', error);
                    // Clean up file if error occurs during processing
                    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

                    res.status(500).json({
                        message: 'Error processing import data',
                        error: error.message
                    });
                }
            });
    } catch (error) {
        console.error('CSV upload error:', error);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ message: 'Server error during upload', error: error.message });
    }
});

/**
 * @route GET /api/import/template
 * @desc Get CSV template for student import
 * @access Private (Admin)
 */
router.get('/template', requireFinanceAccess, (req, res) => {
    // Return a simple CSV template to help users
    const headers = [
        'Student Name', 'Class', 'Gender', 'Phone', 'Phone 2', 'Address',
        'Date of Birth', 'Admission', 'Total Fees', 'To pay', 'Total Paid',
        'Pending', 'Concession', 'Remarks',
        'Reg No', 'SATS Number', 'PEN Number', 'APAAR ID'
    ];
    // Add installment columns dynamically if needed, but for now just static list
    const csvContent = headers.join(',') + '\n';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="student_import_template.csv"');
    res.send(csvContent);
});

module.exports = router;
