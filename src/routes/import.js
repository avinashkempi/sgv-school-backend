const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const { processImport, processStaffImport } = require('../services/importService');
const { authenticateToken, checkRole } = require('../middleware/auth');

const os = require('os');
// Setup multer for file upload
const upload = multer({ dest: os.tmpdir() });

/**
 * @route POST /api/import/students/csv
 * @desc Import students from CSV file
 * @access Private (Admin/Super Admin)
 */
router.post('/students/csv', authenticateToken, checkRole(['admin', 'super admin']), upload.single('file'), async (req, res) => {
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
                    const importResult = await processImport(results, { wipe: wipeData, academicYearId: req.body.academicYearId });

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
router.get('/template', authenticateToken, requireFinanceAccess, (req, res) => {
    // Return a simple CSV template to help users
    const headers = [
        'Student Name', 'Class', 'Gender', 'Phone', 'Phone 2', 'Address',
        'Date of Birth', 'Admission', 'Total Fees', 'Previous Dues', 'To pay', 'Total Paid',
        'Pending', 'Concession', 'Remarks',
        'Reg No', 'SATS Number', 'PEN Number', 'APAAR ID'
    ];
    // Add installment columns dynamically if needed, but for now just static list
    const csvContent = headers.join(',') + '\n';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="student_import_template.csv"');
    res.send(csvContent);
});

/**
 * @route POST /api/import/students/local
 * @desc Import students from local data folder (Direct Sync)
 * @access Private (Admin)
 */
router.post('/students/local', authenticateToken, checkRole(['admin', 'super admin']), async (req, res) => {
    const filePath = './data/student_data.csv';
    const wipeData = req.body.wipe === 'true';
    const academicYearId = req.body.academicYearId;
    const feesOnly = req.body.feesOnly === true || req.body.feesOnly === 'true';
    const results = [];

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({
            message: 'Local import file not found',
            path: filePath
        });
    }

    try {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', async () => {
                try {
                    const importResult = await processImport(results, { wipe: wipeData, academicYearId, feesOnly });
                    res.json({
                        message: 'Local import processed successfully',
                        data: importResult
                    });
                } catch (error) {
                    console.error('Local import processing error:', error);
                    res.status(500).json({
                        message: 'Error processing local data',
                        error: error.message
                    });
                }
            });
    } catch (error) {
        console.error('Local file read error:', error);
        res.status(500).json({ message: 'Server error during local sync', error: error.message });
    }
});

/**
 * @route POST /api/import/staff/local
 * @desc Import staff from local data folder (Direct Sync)
 * @access Private (Admin)
 */
router.post('/staff/local', authenticateToken, requireFinanceAccess, async (req, res) => {
    const filePath = './data/staff_data.csv';
    const results = [];

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({
            message: 'Local staff import file not found',
            path: filePath
        });
    }

    try {
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', async () => {
                try {
                    const importResult = await processStaffImport(results);
                    res.json({
                        message: 'Staff import processed successfully',
                        data: importResult
                    });
                } catch (error) {
                    console.error('Staff import processing error:', error);
                    res.status(500).json({
                        message: 'Error processing staff data',
                        error: error.message
                    });
                }
            });
    } catch (error) {
        console.error('Local file read error:', error);
        res.status(500).json({ message: 'Server error during local sync', error: error.message });
    }
});

module.exports = router;
