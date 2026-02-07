const mongoose = require('mongoose');
const User = require('../models/User');
const StudentFee = require('../models/StudentFee');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const { wipeNonAdminData } = require('./wipeService');
const bcrypt = require('bcryptjs');

// Utility to parse currency string "₹11,900" -> 11900
const parseCurrency = (str) => {
    if (!str) return 0;
    // Remove ₹, comma, spaces
    const cleanStr = str.toString().replace(/[₹,\s]/g, '');
    const num = parseFloat(cleanStr);
    return isNaN(num) ? 0 : num;
};

// Utility to parse date "08-04-2025" -> Date object
const parseDate = (dateStr) => {
    if (!dateStr) return null;
    try {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
            // DD-MM-YYYY -> YYYY-MM-DD
            return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        }
        return new Date(dateStr);
    } catch (e) {
        return null;
    }
};

const processImport = async (csvData, options = { wipe: false }) => {
    const results = {
        total: csvData.length,
        created: 0,
        updated: 0,
        failed: 0,
        errors: []
    };

    try {
        // 1. Optional Wipe
        if (options.wipe) {
            await wipeNonAdminData();
        }

        // 2. Cache Classes and Academic Year
        const classes = await Class.find({});
        const classMap = new Map(classes.map(c => [c.name.toUpperCase(), c._id]));

        // Find or create active academic year
        let academicYear = await AcademicYear.findOne({ isActive: true });
        if (!academicYear) {
            // Fallback or create default
            academicYear = await AcademicYear.findOne({});
        }

        // 3. Process Rows
        for (let i = 0; i < csvData.length; i++) {
            const row = csvData[i];
            const rowNumber = i + 2; // +1 for 0-index, +1 for header

            try {
                // Determine Login/Unique Phone
                // Logic: Phone 2 is primary. If empty, use Phone.
                let loginPhone = row['Phone 2'] ? row['Phone 2'].toString().replace(/\D/g, '') : '';
                const backupPhone = row['Phone'] ? row['Phone'].toString().replace(/\D/g, '') : '';

                if (!loginPhone) {
                    loginPhone = backupPhone;
                }

                if (!loginPhone) {
                    throw new Error('No phone number found for student identity');
                }

                // Resolve Class
                const className = row['Class'] ? row['Class'].toString().toUpperCase() : '';
                const classId = classMap.get(className);

                // Construct Student Data
                const studentData = {
                    name: row['Student Name'],
                    phone: loginPhone, // Unique Key
                    guardianPhone: backupPhone, // Backup contact
                    password: loginPhone, // Default password = phone
                    role: 'student',
                    currentClass: classId,
                    academicYear: academicYear ? academicYear._id : null,

                    // Profile Fields
                    gender: row['Gender'],
                    dateOfBirth: parseDate(row['Date of Birth']),
                    address: row['Address'],
                    isAdmitted: row['Admission'] === 'TRUE' || row['Admission'] === true,
                    remarks: row['Remarks'],

                    // IDs
                    regNo: row['Reg No'],
                    satsNumber: row['SATS Number'],
                    penNumber: row['PEN Number'],
                    apaarId: row['APAAR ID']
                };

                // Upsert Student
                let student = await User.findOne({ phone: loginPhone });
                let isNew = false;

                if (!student) {
                    // Create new
                    student = new User(studentData);
                    // Hash password manually if creating via new User() and saving? 
                    // The User model pre-save hook handles hashing if password modified.
                    isNew = true;
                } else {
                    // Update existing
                    Object.assign(student, studentData);
                    // If we want to reset password to phone on update, uncomment:
                    // student.password = loginPhone; 
                }

                await student.save();
                if (isNew) results.created++; else results.updated++;

                // Process Fees
                await processFees(student, row, academicYear, classId, row['Branch']);

            } catch (error) {
                results.failed++;
                results.errors.push({
                    row: rowNumber,
                    name: row['Student Name'],
                    error: error.message
                });
            }
        }

    } catch (error) {
        throw error;
    }

    return results;
};

const processFees = async (student, row, academicYear, classId, branch) => {
    // Construct Fee Record
    const feeData = {
        student: student._id,
        academicYear: academicYear ? academicYear._id : null,
        class: classId,
        branch: branch,

        totalFees: parseCurrency(row['Total Fees']),
        toPay: parseCurrency(row['To pay']), // Using 'To pay' from sheet or could calc
        totalPaid: parseCurrency(row['Total Paid']),
        pendingAmount: parseCurrency(row['Pending']),
        concession: parseCurrency(row['Concession']),

        payments: []
    };

    // Parse 6 Installments
    for (let k = 1; k <= 6; k++) {
        const amount = parseCurrency(row[`Inst ${k} Amount`]);
        if (amount > 0) {
            feeData.payments.push({
                installmentNumber: k,
                amount: amount,
                date: parseDate(row[`Inst ${k} Date`]),
                invoiceNumber: row[`Inst ${k} Invoice`],
                paymentMode: 'Cash' // Default
            });
        }
    }

    // Upsert Fee Record
    await StudentFee.findOneAndUpdate(
        { student: student._id, academicYear: academicYear ? academicYear._id : null },
        feeData,
        { upsert: true, new: true }
    );
};

module.exports = { processImport };
