const mongoose = require('mongoose');
const User = require('../models/User');
const StudentFee = require('../models/StudentFee');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const FeeStructure = require('../models/FeeStructure');
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
        errors: [],
        classCounts: {},
        updatedStudents: []
    };

    try {
        // 1. Optional Wipe
        if (options.wipe) {
            await wipeNonAdminData({ confirmed: true });
        }

        // 2. Resolve Academic Year FIRST (needed for class creation)
        let academicYear;
        if (options.academicYearId) {
            academicYear = await AcademicYear.findById(options.academicYearId);
        }
        if (!academicYear) {
            academicYear = await AcademicYear.findOne({ isActive: true });
        }
        if (!academicYear) {
            academicYear = await AcademicYear.findOne({});
        }

        // 3. Extract and Create Classes from CSV
        // Get unique class names from CSV
        const uniqueClasses = [...new Set(csvData.map(row => row['Class'] ? row['Class'].toString().toUpperCase() : '').filter(c => c))];
        console.log(`Found ${uniqueClasses.length} unique classes in CSV`);

        // Helper to parse Branch from row (assuming all rows of a class have same branch, or take first)
        const getBranchForClass = (className) => {
            const row = csvData.find(r => r['Class'] && r['Class'].toString().toUpperCase() === className);
            return row ? row['Branch'] : '';
        };

        // Create Classes if they don't exist (or if wiped)
        for (const className of uniqueClasses) {
            const branch = getBranchForClass(className) || 'Main';
            const existingClass = await Class.findOne({ name: className, branch });
            if (!existingClass) {
                const classValue = className.toLowerCase().replace(/\s+/g, '_');
                await Class.create({
                    name: className,
                    value: classValue,
                    label: className,
                    branch,
                    academicYear: academicYear ? academicYear._id : undefined
                });
            }
        }

        // 4. Cache Classes
        const classes = await Class.find({});
        const classMap = new Map(classes.map(c => [c.name.toUpperCase(), c._id]));


        // Track processed classes for fee structure to avoid redundant DB calls per row
        const processedFeeStructures = new Set();

        // 4. Process Rows
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

                if (!classId && className) {
                    console.warn(`Class ${className} not found in map for student ${row['Student Name']}`);
                }

                // Increment Class Count
                if (className) {
                    results.classCounts[className] = (results.classCounts[className] || 0) + 1;
                }

                // --- FEES ONLY MODE ---
                if (options.feesOnly) {
                    // Just find the student and update their fees — don't touch profile
                    const student = await User.findOne({ phone: loginPhone });
                    if (!student) {
                        throw new Error(`Student not found with phone ${loginPhone} (Fees-Only mode skips student creation)`);
                    }
                    await processFees(student, row, academicYear, classId, row['Branch']);
                    results.updated++;
                    results.updatedStudents.push({
                        name: student.name,
                        phone: student.phone,
                        class: className
                    });
                    continue; // Skip to next row
                }

                // --- FULL IMPORT MODE ---
                // Helper to get value from row with normalized keys (trim + case insensitive)
                const getRowValue = (key) => {
                    const normalizedKey = key.toLowerCase().trim();
                    const actualKey = Object.keys(row).find(k => k.toLowerCase().trim() === normalizedKey);
                    return actualKey ? row[actualKey] : null;
                };

                // Process Fee Structure for Class (First record wins)
                if (classId && academicYear && !processedFeeStructures.has(classId.toString())) {
                    await processFeeStructure(classId, academicYear, row);
                    processedFeeStructures.add(classId.toString());
                }

                // Construct Student Data
                const studentData = {
                    name: getRowValue('Student Name'),
                    phone: loginPhone, // Unique Key
                    guardianPhone: backupPhone, // Backup contact
                    password: loginPhone + '@123', // Default password = phone@123
                    role: 'student',
                    currentClass: classId,
                    academicYear: academicYear ? academicYear._id : null,

                    // Profile Fields
                    gender: getRowValue('Gender'),
                    dateOfBirth: parseDate(getRowValue('Date of Birth')),
                    address: getRowValue('Address'),
                    isAdmitted: getRowValue('Admission') === 'TRUE' || getRowValue('Admission') === true || getRowValue('Admission') === 'True',
                    remarks: getRowValue('Remarks'),

                    // IDs
                    regNo: getRowValue('Reg No'),
                    satsNumber: getRowValue('SATS Number'),
                    penNumber: getRowValue('PEN Number'),
                    apaarId: getRowValue('APAAR ID')
                };

                // Upsert Student
                let student = await User.findOne({ phone: loginPhone });
                let isNew = false;

                if (!student) {
                    // Create new
                    student = new User(studentData);
                    isNew = true;
                } else {
                    // Update existing — exclude password so pre-save hook
                    // doesn't double-hash an already-hashed password.
                    const { password: _pw, ...studentUpdateData } = studentData;
                    Object.assign(student, studentUpdateData);
                    // Add to updated list
                    results.updatedStudents.push({
                        name: student.name,
                        phone: student.phone,
                        class: className
                    });
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

// Helper to create Fee Structure from CSV Row
const processFeeStructure = async (classId, academicYear, row) => {
    try {
        // Check if exists for this class/year/default type
        const existing = await FeeStructure.findOne({
            class: classId,
            academicYear: academicYear._id,
            type: 'class_default'
        });

        // Use the Total Fees from the row as the Tuition Fee
        const totalFees = parseCurrency(row['Total Fees']);

        // NOTE: The CSV ("Inst 1 Date", etc.) contains ACTUAL PAYMENT dates/amounts, not a planned schedule.
        // Therefore, we cannot infer a strict "Due Date" schedule for the whole class from one student's payment history.
        // We will create the structure with the Total Amount and Component, leaving the schedule empty for now.
        // Admins can manually add a schedule in the detailed settings if needed.

        const structureData = {
            class: classId,
            academicYear: academicYear._id,
            type: 'class_default',
            totalAmount: totalFees,
            components: [{
                name: 'Tuition Fees',
                amount: totalFees,
                mandatory: true
            }],
            paymentSchedule: [], // No schedule from CSV
            updatedAt: Date.now()
        };

        if (existing) {
            // Update existing structure to match CSV (Source of Truth)
            Object.assign(existing, structureData);
            await existing.save();
        } else {
            // Create new
            await FeeStructure.create(structureData);
        }

    } catch (error) {
        console.error(`Error processing fee structure for class ${classId}:`, error);
        // We log but don't fail the entire import, as individual student fees are processed separately
    }
};

const processFees = async (student, row, academicYear, classId, branch) => {
    // Construct Fee Record
    const feeData = {
        student: student._id,
        academicYear: academicYear ? academicYear._id : null,
        class: classId,
        branch: branch,

        totalFees: parseCurrency(row['Total Fees']),
        arrears: parseCurrency(row['Arrears / Previous Dues'] || row['Previous Dues'] || row['Arrears']),
        toPay: parseCurrency(row['To pay']), // Ensure this is accurate from CSV
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
                paymentMode: row[`Inst ${k} Mode`] || 'Cash' // Use mode from CSV if available, else Cash
            });
        }
    }

    // Upsert Fee Record - Using $set to overwrite all fields with CSV data
    await StudentFee.findOneAndUpdate(
        { student: student._id, academicYear: academicYear ? academicYear._id : null },
        { $set: feeData }, // Explicitly set all fields to match CSV
        { upsert: true, new: true }
    );
};

const processStaffImport = async (csvData) => {
    const results = {
        total: csvData.length,
        created: 0,
        updated: 0,
        failed: 0,
        errors: [],
        designationCounts: {},
        createdStaff: [],
        updatedStaff: []
    };

    for (let i = 0; i < csvData.length; i++) {
        const row = csvData[i];
        const rowNumber = i + 2;

        try {
            const name = row['Name'];
            const phone = row['Phone'] ? row['Phone'].toString().replace(/\D/g, '') : '';
            const designation = row['Designation'] ? row['Designation'].trim() : '';

            if (!name || !phone) {
                throw new Error('Name and Contact are required');
            }

            // Determine Role
            let role = 'support_staff'; // Default
            const lowerDesig = designation.toLowerCase();

            if (lowerDesig === 'headmaster' || lowerDesig === 'principal') {
                role = 'admin';
            } else if (lowerDesig.includes('assistant teacher') || lowerDesig === 'teacher') {
                role = 'teacher';
            } else if (lowerDesig === 'clerk' || lowerDesig === 'computer instructor') {
                role = 'staff';
            } else {
                role = 'support_staff';
            }

            // Count Designations
            results.designationCounts[designation] = (results.designationCounts[designation] || 0) + 1;

            // Construct User Data
            const userData = {
                name: name,
                phone: phone,
                password: phone + '@123', // Default password = phone@123
                role: role,
                designation: designation, // Store exact designation

                // Profile Fields
                dateOfBirth: parseDate(row['Date of Birth']),
                bloodGroup: row['Blood Group'],
                address: row['Address'],

                // Ensure no student-specific fields interfere
                currentClass: null,
                academicYear: null
            };

            // Upsert User
            let user = await User.findOne({ phone: phone });
            let isNew = false;

            if (!user) {
                user = new User(userData);
                isNew = true;
            } else {
                // Update existing — exclude password so pre-save hook
                // doesn't double-hash an already-hashed password.
                const { password: _pw, ...userUpdateData } = userData;
                // Only update if role is not super admin (safety)
                if (user.role !== 'super admin') {
                    Object.assign(user, userUpdateData);
                } else {
                    // If super admin, update profile details but NOT role
                    const { role, ...safeUpdates } = userUpdateData;
                    Object.assign(user, safeUpdates);
                }
            }

            await user.save();
            if (isNew) {
                results.created++;
                results.createdStaff.push({
                    name: user.name,
                    designation: user.designation,
                    phone: user.phone
                });
            } else {
                results.updated++;
                results.updatedStaff.push({
                    name: user.name,
                    designation: user.designation,
                    phone: user.phone
                });
            }

        } catch (error) {
            results.failed++;
            results.errors.push({
                row: rowNumber,
                name: row['Name'],
                error: error.message
            });
        }
    }

    return results;
};

module.exports = { processImport, processStaffImport };
