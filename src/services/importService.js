const mongoose = require('mongoose');
const User = require('../models/User');
const StudentFee = require('../models/StudentFee');
const Class = require('../models/Class');
const AcademicYear = require('../models/AcademicYear');
const FeeStructure = require('../models/FeeStructure');
const { wipeNonAdminData } = require('./wipeService');

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

const generateTemporaryPassword = (phone) => `${phone}@123`;

const getRowValue = (row, key) => {
    const normalizedKey = key.toLowerCase().trim();
    const actualKey = Object.keys(row).find(k => k.toLowerCase().trim() === normalizedKey);
    return actualKey ? row[actualKey] : null;
};

const normalizeBranch = (branch) => {
    const value = (branch || 'Main').toString().trim();
    return ['Ugar', 'Mangasuli', 'Main'].includes(value) ? value : 'Main';
};

const classMapKey = (academicYearId, branch, className) => `${academicYearId || 'none'}:${branch}:${className.toUpperCase()}`;

const executeInBatches = async (Model, ops, batchSize = 500) => {
    for (let i = 0; i < ops.length; i += batchSize) {
        const batch = ops.slice(i, i + batchSize);
        await Model.bulkWrite(batch);
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
        updatedStudents: [],
        createdStudents: []
    };

    // 1. Resolve Academic Year FIRST (needed for class creation and scoped wipes)
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

    // 2. Optional Wipe, scoped to the selected or active academic year.
    if (options.wipe) {
        await wipeNonAdminData({ confirmed: true, academicYearId: academicYear?._id });
    }

    // 3. Extract and Create Classes from CSV, scoped by branch and academic year.
    const uniqueClassEntries = new Map();
    for (const row of csvData) {
        const className = row['Class'] ? row['Class'].toString().toUpperCase().trim() : '';
        if (!className) continue;
        const branch = normalizeBranch(row['Branch']);
        uniqueClassEntries.set(classMapKey(academicYear?._id, branch, className), { className, branch });
    }
    console.log(`Found ${uniqueClassEntries.size} unique class/branch entries in CSV`);

    for (const { className, branch } of uniqueClassEntries.values()) {
        const classValue = className.toLowerCase().replace(/\s+/g, '_');
        const existingClass = await Class.findOne({ name: className, branch, academicYear: academicYear?._id });
        if (!existingClass) {
            await Class.create({
                name: className,
                value: classValue,
                label: className,
                branch,
                academicYear: academicYear ? academicYear._id : undefined
            });
        }
    }

    // 4. Cache Classes for the target academic year only.
    const classes = await Class.find(academicYear ? { academicYear: academicYear._id } : {});
    const classMap = new Map(classes.map(c => [classMapKey(c.academicYear, c.branch, c.name), c._id]));

    // 5. Pre-fetch existing users in one query
    const phoneNumbers = [];
    for (const row of csvData) {
        let phone = row['Phone 2'] ? row['Phone 2'].toString().replace(/\D/g, '') : '';
        if (!phone && row['Phone']) {
            phone = row['Phone'].toString().replace(/\D/g, '');
        }
        if (phone) phoneNumbers.push(phone);
    }

    const existingUsers = await User.find({ phone: { $in: phoneNumbers } }).lean();
    const userMap = new Map(existingUsers.map(u => [u.phone, u]));

    const processedFeeStructures = new Set();
    const userBulkOps = [];
    const feeBulkOps = [];

    // 6. Process Rows
    for (let i = 0; i < csvData.length; i++) {
        const row = csvData[i];
        const rowNumber = i + 2; // +1 for 0-index, +1 for header

        try {
            // Determine Login/Unique Phone
            let loginPhone = row['Phone 2'] ? row['Phone 2'].toString().replace(/\D/g, '') : '';
            const backupPhone = row['Phone'] ? row['Phone'].toString().replace(/\D/g, '') : '';

            if (!loginPhone) {
                loginPhone = backupPhone;
            }

            if (!loginPhone) {
                throw new Error('No phone number found for student identity');
            }

            // Resolve Class
            const className = row['Class'] ? row['Class'].toString().toUpperCase().trim() : '';
            const branch = normalizeBranch(row['Branch']);
            const classId = classMap.get(classMapKey(academicYear?._id, branch, className));

            if (!classId && className) {
                console.warn(`Class ${className} not found in map for student ${row['Student Name']}`);
            }

            // Increment Class Count
            if (className) {
                results.classCounts[className] = (results.classCounts[className] || 0) + 1;
            }

            // --- FEES ONLY MODE ---
            if (options.feesOnly) {
                const student = userMap.get(loginPhone);
                if (!student) {
                    throw new Error(`Student not found with phone ${loginPhone} (Fees-Only mode skips student creation)`);
                }
                const feeData = buildFeeData(student._id, row, academicYear, classId, branch);
                feeBulkOps.push({
                    updateOne: {
                        filter: { student: student._id, academicYear: academicYear ? academicYear._id : null },
                        update: { $set: feeData },
                        upsert: true
                    }
                });
                results.updated++;
                results.updatedStudents.push({
                    name: student.name,
                    phone: student.phone,
                    class: className
                });
                continue; // Skip to next row
            }

            // --- FULL IMPORT MODE ---
            if (classId && academicYear && !processedFeeStructures.has(classId.toString())) {
                await processFeeStructure(classId, academicYear, row);
                processedFeeStructures.add(classId.toString());
            }

            const studentData = {
                name: getRowValue(row, 'Student Name'),
                phone: loginPhone,
                guardianPhone: backupPhone,
                password: generateTemporaryPassword(loginPhone),
                mustChangePassword: true,
                role: 'student',
                currentClass: classId,
                academicYear: academicYear ? academicYear._id : null,
                gender: getRowValue(row, 'Gender'),
                dateOfBirth: parseDate(getRowValue(row, 'Date of Birth')),
                address: getRowValue(row, 'Address'),
                remarks: getRowValue(row, 'Remarks'),
                regNo: getRowValue(row, 'Reg No'),
                satsNumber: getRowValue(row, 'SATS Number'),
                penNumber: getRowValue(row, 'PEN Number'),
                apaarId: getRowValue(row, 'APAAR ID')
            };

            let student = userMap.get(loginPhone);
            if (!student) {
                const newId = new mongoose.Types.ObjectId();
                studentData._id = newId;
                userBulkOps.push({ insertOne: { document: studentData } });
                userMap.set(loginPhone, studentData);
                student = studentData;
                results.created++;
                if (!results.createdStudents) results.createdStudents = [];
                results.createdStudents.push({
                    name: studentData.name,
                    phone: studentData.phone,
                    class: className,
                    temporaryPassword: studentData.password
                });
            } else {
                const { password: _pw, mustChangePassword: _mcp, ...studentUpdateData } = studentData;
                userBulkOps.push({
                    updateOne: {
                        filter: { _id: student._id },
                        update: { $set: studentUpdateData }
                    }
                });
                Object.assign(student, studentUpdateData);
                results.updated++;
                results.updatedStudents.push({
                    name: student.name,
                    phone: student.phone,
                    class: className
                });
            }

            const feeData = buildFeeData(student._id, row, academicYear, classId, branch);
            feeBulkOps.push({
                updateOne: {
                    filter: { student: student._id, academicYear: academicYear ? academicYear._id : null },
                    update: { $set: feeData },
                    upsert: true
                }
            });

        } catch (error) {
            results.failed++;
            results.errors.push({
                row: rowNumber,
                name: row['Student Name'],
                error: error.message
            });
        }
    }

    if (userBulkOps.length > 0) {
        await executeInBatches(User, userBulkOps);
    }
    if (feeBulkOps.length > 0) {
        await executeInBatches(StudentFee, feeBulkOps);
    }

    return results;
};

// Helper to create Fee Structure from CSV Row
const processFeeStructure = async (classId, academicYear, row) => {
    try {
        const existing = await FeeStructure.findOne({
            class: classId,
            academicYear: academicYear._id,
            type: 'class_default'
        });

        const totalFees = parseCurrency(row['Total Fees']);

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
            paymentSchedule: [],
            updatedAt: Date.now()
        };

        if (existing) {
            Object.assign(existing, structureData);
            await existing.save();
        } else {
            await FeeStructure.create(structureData);
        }

    } catch (error) {
        console.error(`Error processing fee structure for class ${classId}:`, error);
    }
};

const buildFeeData = (studentId, row, academicYear, classId, branch) => {
    const totalFees = parseCurrency(row['Total Fees']);
    const arrears = parseCurrency(row['Arrears / Previous Dues'] || row['Previous Dues'] || row['Arrears']);
    const concession = parseCurrency(row['Concession']);
    const rawToPay = parseCurrency(row['To pay']);
    const toPay = rawToPay > 0 || row['To pay'] !== undefined ? rawToPay : Math.max(0, totalFees + arrears - concession);
    const totalPaid = parseCurrency(row['Total Paid']);
    const rawPending = parseCurrency(row['Pending']);
    const pendingAmount = rawPending > 0 || row['Pending'] !== undefined ? rawPending : Math.max(0, toPay - totalPaid);

    const feeData = {
        student: studentId,
        academicYear: academicYear ? academicYear._id : null,
        class: classId,
        branch: branch,

        totalFees,
        arrears,
        toPay,
        totalPaid,
        pendingAmount,
        concession,

        payments: [],
        updatedAt: new Date()
    };

    for (let k = 1; k <= 6; k++) {
        const amount = parseCurrency(row[`Inst ${k} Amount`]);
        if (amount > 0) {
            feeData.payments.push({
                installmentNumber: k,
                amount: amount,
                date: parseDate(row[`Inst ${k} Date`]),
                invoiceNumber: row[`Inst ${k} Invoice`],
                paymentMode: row[`Inst ${k} Mode`] || 'Cash'
            });
        }
    }

    return feeData;
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

    const phoneNumbers = [];
    for (const row of csvData) {
        const phone = row['Phone'] ? row['Phone'].toString().replace(/\D/g, '') : '';
        if (phone) phoneNumbers.push(phone);
    }

    const existingStaff = await User.find({ phone: { $in: phoneNumbers } }).lean();
    const staffMap = new Map(existingStaff.map(u => [u.phone, u]));

    const userBulkOps = [];

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

            let role = 'support_staff';
            const lowerDesig = designation.toLowerCase();

            if (lowerDesig === 'headmaster' || lowerDesig === 'principal') {
                role = 'admin';
            } else if (lowerDesig.includes('assistant teacher') || lowerDesig === 'teacher') {
                role = 'teacher';
            } else if (lowerDesig === 'clerk' || lowerDesig.includes('instructor') || lowerDesig.includes('physical instructor')) {
                role = 'staff';
            } else {
                role = 'support_staff';
            }

            results.designationCounts[designation] = (results.designationCounts[designation] || 0) + 1;

            const userData = {
                name: name,
                phone: phone,
                password: generateTemporaryPassword(phone),
                mustChangePassword: true,
                role: role,
                designation: designation,

                dateOfBirth: parseDate(row['Date of Birth']),
                bloodGroup: row['Blood Group'],
                address: row['Address'],

                currentClass: null,
                academicYear: null
            };

            let user = staffMap.get(phone);
            if (!user) {
                const newId = new mongoose.Types.ObjectId();
                userData._id = newId;
                userBulkOps.push({ insertOne: { document: userData } });
                staffMap.set(phone, userData);
                results.created++;
                results.createdStaff.push({
                    name: userData.name,
                    designation: userData.designation,
                    phone: userData.phone,
                    temporaryPassword: userData.password
                });
            } else {
                const { password: _pw, mustChangePassword: _mcp, ...userUpdateData } = userData;
                if (user.role !== 'super admin') {
                    userBulkOps.push({ updateOne: { filter: { _id: user._id }, update: { $set: userUpdateData } } });
                } else {
                    const { role: _r, ...safeUpdates } = userUpdateData;
                    userBulkOps.push({ updateOne: { filter: { _id: user._id }, update: { $set: safeUpdates } } });
                }
                Object.assign(user, userUpdateData);
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

    if (userBulkOps.length > 0) {
        await executeInBatches(User, userBulkOps);
    }

    return results;
};

module.exports = { processImport, processStaffImport };
